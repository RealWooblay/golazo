import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  settleRoomMarket,
  type ClientMessage,
  type GameState,
  type Outcome,
  type RoomBet,
  type RoomMarket,
  type RoomPlayer,
  type RoomState,
  type Side,
  type Team,
} from "@golazo/core";
import { connectFeed, type FeedSocket } from "@/lib/ws";
import { useStore } from "@/state/store";
import { buildInviteLink } from "./invite";

/**
 * useFriendsRoom — the transport for FRIENDS MODE (private friends rooms).
 *
 * It connects to the SAME feed service as the match loop (over `connectFeed`,
 * since the room ClientMessages/ServerMessages are part of @golazo/core's wire
 * unions and flow through it unchanged) and exposes one flat, authoritative view
 * model the friends UI renders directly.
 *
 * AUTHORITY: the server owns balances + room state. We never compute balances or
 * mutate the roster locally — we render whatever the latest `room_state` says and
 * only QUEUE reveals (the outcome of MY bets) for the UI to animate for flavour.
 * The $ in those reveals is visual; the real balances already arrived via
 * room_state before the resolve frame's reveal is acknowledged.
 *
 * We deliberately do NOT touch the global `$` play-money store: a room balance is
 * a separate, room-only $ tab (a private session settled once at full time).
 *
 * userId — STABLE PER CLIENT, BUT DISTINCT PER TAB:
 *   The whole point of friends mode is two players. To let two browser tabs on
 *   ONE machine act as two distinct players, we DON'T key off the global "me" id
 *   (config.USER_ID) and we DON'T use localStorage (shared across same-origin
 *   tabs). Instead each hook instance mints a random id at mount and persists it
 *   to `sessionStorage` on web (per-tab) and `AsyncStorage` on native (per
 *   install), under key 'golazo:friend-uid'. Result: two tabs = two players;
 *   reloading one tab keeps that tab's identity.
 */

export type RoomConnState = "idle" | "connecting" | "connected" | "error";

/** Queued (for MY bet) so the UI can animate a win/loss/void reveal. */
export interface FriendsRoomReveal {
  marketId: string;
  question: string;
  team?: Team;
  side: "YES" | "NO";
  stake: number;
  payoutMult: number;
  outcome: "YES" | "NO" | "VOID";
  won: boolean;
  payout: number;
}

export interface UseFriendsRoom {
  conn: RoomConnState;
  error?: string;
  userId: string;
  isHost: boolean;
  code?: string;
  state?: RoomState;
  game?: GameState;
  commentary?: string;
  /** Leaderboard order (balance desc). */
  players: RoomPlayer[];
  me?: RoomPlayer;
  opponent?: RoomPlayer;
  /** Markets currently open or locked for betting (at most one). */
  activeMarkets: RoomMarket[];
  openMarkets: RoomMarket[];
  /** My current bet on each market, keyed by marketId. */
  myBetByMarket: Record<string, RoomBet | undefined>;
  /** Queued reveals (mine) to animate. */
  reveals: FriendsRoomReveal[];
  createRoom: (name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leaveRoom: () => void;
  placeBet: (marketId: string, side: "YES" | "NO", stake: number) => void;
  makeMarket: (
    question: string,
    opts?: { team?: "home" | "away"; windowMs?: number },
  ) => void;
  resolveMarket: (
    marketId: string,
    outcome: "YES" | "NO" | "VOID",
  ) => void;
  acknowledgeReveal: (marketId: string) => void;
  /** Shareable join link for this room (set once we know the code). */
  inviteLink?: string;
}

const FRIEND_UID_KEY = "golazo:friend-uid";

/** Mint a reasonably-unique, opaque per-client id. */
function randomUid(): string {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * Synchronously resolve a per-tab (web) userId from sessionStorage, minting +
 * persisting one if absent. Native returns null here and resolves async below.
 */
function readWebUid(): string | null {
  if (Platform.OS !== "web") return null;
  try {
    if (typeof sessionStorage === "undefined") return randomUid();
    const existing = sessionStorage.getItem(FRIEND_UID_KEY);
    if (existing) return existing;
    const fresh = randomUid();
    sessionStorage.setItem(FRIEND_UID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / disabled storage — fall back to an in-memory id.
    return randomUid();
  }
}

export function useFriendsRoom(): UseFriendsRoom {
  const { liveUrl } = useStore();

  // userId is fixed for the lifetime of this hook instance. On web we can read it
  // synchronously (per-tab via sessionStorage); on native we seed an in-memory id
  // now and reconcile with AsyncStorage on mount (per-install, stable across
  // reloads). Either way it's distinct from the global "me" id.
  const [userId] = useState<string>(() => readWebUid() ?? randomUid());
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // ---- view-model state ----
  const [conn, setConn] = useState<RoomConnState>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [code, setCode] = useState<string | undefined>(undefined);
  const [state, setState] = useState<RoomState | undefined>(undefined);
  const [game, setGame] = useState<GameState | undefined>(undefined);
  const [commentary, setCommentary] = useState<string | undefined>(undefined);
  const [reveals, setReveals] = useState<FriendsRoomReveal[]>([]);

  // ---- refs read inside socket callbacks ----
  const socketRef = useRef<FeedSocket | null>(null);
  const pendingRef = useRef<ClientMessage | null>(null);
  const codeRef = useRef<string | undefined>(undefined);
  codeRef.current = code;
  /** Set once the user creates/joins — drives the persistent WS session + rejoin. */
  const sessionActiveRef = useRef(false);
  /** Name + room code to replay after a reconnect. */
  const membershipRef = useRef<{ code?: string; name: string } | null>(null);

  // Native: reconcile the in-memory userId with the persisted per-install id.
  // (No-op on web, where sessionStorage already gave us a per-tab id.) We don't
  // re-render unless the persisted id differs from what we minted — but since the
  // hook captured the minted id in state we keep it; persistence just makes a
  // RELOAD on the same install reuse the same id for the NEXT mount. To honour
  // "stable across reloads" we adopt the persisted id if one already existed.
  const [nativeUid, setNativeUid] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (Platform.OS === "web") return;
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = (
          require("@react-native-async-storage/async-storage") as {
            default: {
              getItem: (k: string) => Promise<string | null>;
              setItem: (k: string, v: string) => Promise<void>;
            };
          }
        ).default;
        const existing = await AsyncStorage.getItem(FRIEND_UID_KEY);
        if (!alive) return;
        if (existing) {
          setNativeUid(existing);
        } else {
          await AsyncStorage.setItem(FRIEND_UID_KEY, userIdRef.current);
        }
      } catch {
        /* AsyncStorage unavailable — keep the in-memory id (in-memory fallback) */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The effective id: a persisted native id (if we adopted one) wins over the
  // minted one; on web the minted (sessionStorage) id is already effective.
  const effectiveUserId = nativeUid ?? userId;
  const effectiveUserIdRef = useRef(effectiveUserId);
  effectiveUserIdRef.current = effectiveUserId;

  const inviteLink = useMemo(
    () => (code ? buildInviteLink(code) : undefined),
    [code],
  );

  // ================================================================
  // Connection lifecycle. LAZY: opens on the FIRST create/join, then STAYS UP
  // with auto-reconnect + room rejoin (mobile browsers drop WS constantly).
  // ================================================================
  const [sessionActive, setSessionActive] = useState(false);

  useEffect(() => {
    if (!sessionActive) return;

    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const replayMembership = (socket: FeedSocket) => {
      const m = membershipRef.current;
      const c = codeRef.current;
      if (c && m?.name) {
        socket.send({
          t: "room_join",
          code: c,
          userId: effectiveUserIdRef.current,
          name: m.name,
        });
      } else if (pendingRef.current) {
        socket.send(pendingRef.current);
        pendingRef.current = null;
      }
    };

    const onDrop = (reason: string) => {
      if (cancelled) return;
      socketRef.current = null;
      attempts += 1;
      setConn("connecting");
      setError(
        attempts >= 4 ? `Reconnecting (${reason})…` : undefined,
      );
      const delay = Math.min(8000, 1500 * Math.min(attempts, 5));
      retryTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) return;
      setConn("connecting");

      const socket = connectFeed(liveUrl, {
        onOpen: () => {
          if (cancelled) return;
          attempts = 0;
          setConn("connected");
          setError(undefined);
          socketRef.current = socket;
          replayMembership(socket);
        },
        onClose: (reason) => onDrop(reason),
        onMessage: (msg) => {
          if (cancelled) return;
          switch (msg.t) {
            case "game":
              setGame(msg.game);
              break;
            case "commentary":
              setCommentary(msg.text);
              break;
            case "room_state": {
              const next = msg.state;
              const mine = next.players.some(
                (p) => p.userId === effectiveUserIdRef.current,
              );
              if (!mine) break;
              setState(next);
              if (next.code !== codeRef.current) {
                setCode(next.code);
              }
              membershipRef.current = {
                code: next.code,
                name:
                  next.players.find(
                    (p) => p.userId === effectiveUserIdRef.current,
                  )?.name ?? membershipRef.current?.name ?? "",
              };
              break;
            }
            case "room_market_resolve": {
              if (msg.code !== codeRef.current) break;
              const reveal = buildReveal(msg.market, effectiveUserIdRef.current);
              if (reveal) {
                setReveals((prev) =>
                  prev.some((r) => r.marketId === reveal.marketId)
                    ? prev
                    : [...prev, reveal],
                );
              }
              break;
            }
            case "room_error": {
              if (msg.code && msg.code !== codeRef.current) break;
              setError(msg.message);
              break;
            }
            default:
              break;
          }
        },
      });
      socketRef.current = socket;
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionActive, liveUrl]);

  const ensureSocket = useCallback((): FeedSocket => {
    if (!sessionActiveRef.current) {
      sessionActiveRef.current = true;
      setSessionActive(true);
    }
    if (socketRef.current) return socketRef.current;
    // Socket is being opened by the effect — queue the frame for onOpen.
    return {
      send: (msg: ClientMessage) => {
        pendingRef.current = msg;
        return false;
      },
      close: () => {},
    };
  }, []);

  /** Send a frame now if the socket is open, else open it + queue to flush. */
  const sendOrQueue = useCallback(
    (frame: ClientMessage) => {
      const socket = ensureSocket();
      if (!socket.send(frame)) pendingRef.current = frame;
    },
    [ensureSocket],
  );

  // Close the socket when the provider unmounts (app teardown).
  useEffect(() => {
    return () => {
      sessionActiveRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  // ---- actions (all send a typed ClientMessage over the live socket) ----

  const createRoom = useCallback(
    (name: string) => {
      membershipRef.current = { name };
      sendOrQueue({ t: "room_create", userId: effectiveUserIdRef.current, name });
    },
    [sendOrQueue],
  );

  const joinRoom = useCallback(
    (joinCode: string, name: string) => {
      const normalized = joinCode.trim().toUpperCase();
      membershipRef.current = { code: normalized, name };
      setCode(normalized);
      sendOrQueue({
        t: "room_join",
        userId: effectiveUserIdRef.current,
        name,
        code: normalized,
      });
    },
    [sendOrQueue],
  );

  const leaveRoom = useCallback(() => {
    const c = codeRef.current;
    if (c) {
      socketRef.current?.send({
        t: "room_leave",
        code: c,
        userId: effectiveUserIdRef.current,
      });
    }
    sessionActiveRef.current = false;
    setSessionActive(false);
    membershipRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    pendingRef.current = null;
    setConn("idle");
    setCode(undefined);
    setState(undefined);
    setReveals([]);
  }, []);

  const placeBet = useCallback(
    (marketId: string, side: "YES" | "NO", stake: number) => {
      const c = codeRef.current;
      if (!c) return;
      socketRef.current?.send({
        t: "room_bet",
        code: c,
        userId: effectiveUserIdRef.current,
        marketId,
        side: side as Side,
        stake,
      });
    },
    [],
  );

  const makeMarket = useCallback(
    (
      question: string,
      opts?: { team?: "home" | "away"; windowMs?: number },
    ) => {
      const c = codeRef.current;
      if (!c) return;
      socketRef.current?.send({
        t: "room_make_market",
        code: c,
        userId: effectiveUserIdRef.current,
        question,
        ...(opts?.team ? { team: opts.team as Team } : {}),
        ...(typeof opts?.windowMs === "number"
          ? { windowMs: opts.windowMs }
          : {}),
      });
    },
    [],
  );

  const resolveMarket = useCallback(
    (marketId: string, outcome: "YES" | "NO" | "VOID") => {
      const c = codeRef.current;
      if (!c) return;
      socketRef.current?.send({
        t: "room_resolve_market",
        code: c,
        userId: effectiveUserIdRef.current,
        marketId,
        outcome: outcome as Outcome,
      });
    },
    [],
  );

  const acknowledgeReveal = useCallback((marketId: string) => {
    // Visual only — the balance already came from room_state. Just dequeue.
    setReveals((prev) => prev.filter((r) => r.marketId !== marketId));
  }, []);

  // ---- derived view model ----

  const players = useMemo<RoomPlayer[]>(
    () =>
      state ? [...state.players].sort((a, b) => b.balance - a.balance) : [],
    [state],
  );

  const me = useMemo<RoomPlayer | undefined>(
    () => state?.players.find((p) => p.userId === effectiveUserId),
    [state, effectiveUserId],
  );

  const opponent = useMemo<RoomPlayer | undefined>(
    () => state?.players.find((p) => p.userId !== effectiveUserId),
    [state, effectiveUserId],
  );

  const isHost = me?.isHost ?? false;

  const activeMarkets = useMemo<RoomMarket[]>(() => {
    if (!state) return [];
    return state.markets.filter(
      (m) => m.status === "open" || m.status === "locked",
    );
  }, [state]);

  const openMarkets = useMemo<RoomMarket[]>(
    () => activeMarkets.filter((m) => m.status === "open"),
    [activeMarkets],
  );

  const myBetByMarket = useMemo<Record<string, RoomBet | undefined>>(() => {
    const out: Record<string, RoomBet | undefined> = {};
    if (!state) return out;
    for (const m of state.markets) {
      out[m.id] = m.bets.find((b) => b.userId === effectiveUserId);
    }
    return out;
  }, [state, effectiveUserId]);

  return {
    conn,
    error,
    userId: effectiveUserId,
    isHost,
    code,
    state,
    game,
    commentary,
    players,
    me,
    opponent,
    activeMarkets,
    openMarkets,
    myBetByMarket,
    reveals,
    createRoom,
    joinRoom,
    leaveRoom,
    placeBet,
    makeMarket,
    resolveMarket,
    acknowledgeReveal,
    inviteLink,
  };
}

/**
 * Build the reveal for MY bet on a just-resolved room market, or null if I had no
 * bet. Runs the core `settleRoomMarket` (the SAME rake-free parimutuel the server
 * settles with) and pulls MY line out of the settlement, so the win/refund math —
 * including the one-sided refund guard — matches the authoritative balances.
 *
 * payoutMult is derived: payout ÷ stake (parimutuel has no fixed multiple), so a
 * winning split shows its realised multiple and a refund reads as 1.00x.
 */
function buildReveal(
  market: RoomMarket,
  uid: string,
): FriendsRoomReveal | null {
  if (market.outcome === undefined) return null;
  const bet = market.bets.find((b) => b.userId === uid);
  if (!bet) return null;
  const settlement = settleRoomMarket(market, market.outcome);
  const mine = settlement.payouts.find((p) => p.userId === uid);
  if (!mine) return null;
  const payoutMult = mine.stake > 0 ? mine.payout / mine.stake : 0;
  return {
    marketId: market.id,
    question: market.question,
    team: market.team,
    side: bet.side,
    stake: bet.stake,
    payoutMult,
    outcome: market.outcome,
    won: mine.won,
    payout: mine.payout,
  };
}
