import { useCallback, useEffect, useRef, useState } from "react";
import {
  MarketEngine,
  SimMatch,
  indicativeQuote,
  triggerFromEvent,
  outcomeFromEvent,
  POINTS_RAKE,
  type FeedEvent,
  type GameState,
  type Market,
  type Outcome,
  type PointsMarketSnapshot,
  type Settlement,
  type Side,
} from "@golazo/core";
import { useStore } from "@/state/store";
import { usePointsIdentity } from "@/features/points/usePointsIdentity";
import { runBots, type BotRunner } from "@/lib/bots";
import { connectFeed, type FeedSocket } from "@/lib/ws";
import { BASE_SEED, RAKE, USER_ID, bettingClosesAt } from "@/lib/config";
import { multiple } from "@/lib/format";
import type {
  BetRow,
  ClosedMarketVM,
  MarketVM,
  PendingBet,
  RevealVM,
  FeedMode,
} from "@/state/types";

/**
 * useGameFeed — the heart of the live loop on the device.
 *
 * It exposes one flat view model (scoreboard, commentary, active markets,
 * pending bets, reveal queue) plus a `placeBet` action, and runs in two
 * interchangeable modes:
 *
 *   OFFLINE (default, zero backend)
 *     SimMatch (the "feed") + a local MarketEngine. On every tick we:
 *       sim.due(now) ─▶ triggerFromEvent ─▶ engine.openMarket ─▶ runBots
 *       at lockAt:      engine.lock
 *       on goal/miss:   engine.resolve(outcomeFromEvent(ev))
 *     The attack and its resolving goal/miss are correlated by meta.sequenceId,
 *     so we resolve the RIGHT market even if events overlap. This mirrors
 *     index.html exactly, but every number now flows through @golazo/core's pool
 *     math, and the human's bet is a real `engine.placeBet` — so the engine's
 *     settlement produces the user's final pool-share payout for us.
 *
 *   LIVE
 *     Connect to the feed service over WebSocket. Render game/market straight
 *     from ServerMessages; send a `bet` ClientMessage on tap; credit the user
 *     from the market_resolve settlement's per-user payout. If the socket fails
 *     at any point, fall back to OFFLINE automatically and surface it.
 *
 * TIMING — the two rules that make this safe and never-spoil:
 *   1. LOCK BEFORE RESOLVE. Betting always closes (engine.lock at lockAt) a few
 *      seconds BEFORE the goal/miss event arrives. You can never bet on a moment
 *      that's already decided. The sim schedules the resolving event well after
 *      the window; live mode trusts the server's market_lock/_resolve order.
 *   2. INDICATIVE ODDS ONLY. placeBet records the multiple shown at tap time for
 *      UX/history, but final payout floats with the pool until betting closes.
 *
 * (Lives under features/match now — it's owned end-to-end by the match feature.
 * All imports are `@/`-aliased, so the relocation needed no path churn; we did
 * upgrade the settlement → ledger write to a full `BetRow` via `addBet`, so the
 * Profile screen gets payout multiple + the full question, not a lossy legacy row.)
 */

export interface GameFeedVM {
  game: GameState | null;
  commentary: string;
  /** The agent's live read of who's pressing — drives the momentum bar. */
  momentum: "home" | "away" | null;
  /** Continuous lean toward a side in [0..1] (0 = home/left, 1 = away/right, 0.5 =
   *  even). Lets the bar move smoothly with the run of play; null = no read yet. */
  momentumLean: number | null;
  markets: MarketVM[];
  market: MarketVM | null;
  pendingByMarket: Record<string, PendingBet | undefined>;
  pending: PendingBet | null;
  reveals: RevealVM[];
  /** Compatibility alias for the first queued reveal. Prefer `reveals`. */
  activeReveal: RevealVM | null;
  /** Older settled markets — compact rows, outcomes always visible. */
  historicMarkets: ClosedMarketVM[];
  /** True while loading session history (fresh join) — no big reveal card. */
  catchingUp: boolean;
  effectiveMode: FeedMode;
  fallbackNotice: string | null;
}

export interface GameFeedApi extends GameFeedVM {
  /** Tap YES/NO. Returns the estimated multiple (for the toast) or null if rejected. */
  placeBet: (side: Side, stake: number, marketId?: string) => number | null;
  /** Acknowledge one reveal: credit winnings/refund, push history, clear it. */
  acknowledgeReveal: (marketId: string) => void;
  /** A short "Bet YES · est. 3.48x"-style toast string, or null. */
  toast: string | null;
  clearToast: () => void;
}

/** Belt-and-braces: if a locked market's resolving event never shows (it always
 *  does in the sim), VOID it after this so money is refunded, never stuck. */
const OFFLINE_RESOLVE_SAFETY_MS = 8000;

let _betSeq = 0;
const betRowId = () =>
  `bet_${Date.now().toString(36)}_${(_betSeq++).toString(36)}`;

export function useGameFeed(): GameFeedApi {
  const store = useStore();
  const { mode, liveUrl, session, pointsBalance, pointsRank } = store;
  const pointsMode = session.moneyMode === "points";
  // Points are a SINGLE cross-mode score. In PAPER mode the points identity is
  // the device's pointsUserId (its paper-pool player). In REAL mode the points
  // are credited off the real settlement, which is keyed by the engine USER_ID —
  // so we join the points system under USER_ID there, and both the leaderboard
  // and points_settle line up with the real bet's payout userId.
  // Account-stable points identity (one account = one leaderboard player on
  // every device). Signed out, this is the device-local id. See usePointsIdentity.
  const { pointsUserId, name: pointsName } = usePointsIdentity();
  const pointsId = pointsMode ? pointsUserId : USER_ID;

  // ---- view-model state (what the screen draws) ----
  const [game, setGame] = useState<GameState | null>(null);
  const [commentary, setCommentary] = useState("Connecting to the match…");
  const [momentum, setMomentum] = useState<"home" | "away" | null>(null);
  // CONTINUOUS lean toward a side in [0..1]: 0 = all home (left), 1 = all away
  // (right), 0.5 = even. Derived from the server's home/away pressure values so the
  // bar tracks the RUN OF PLAY and visibly moves even while one team stays on top —
  // rather than snapping to 3 fixed positions off the binary leader and looking
  // frozen. Null until the first momentum frame arrives.
  const [momentumLean, setMomentumLean] = useState<number | null>(null);
  const [markets, setMarkets] = useState<MarketVM[]>([]);
  const [pendingByMarket, setPendingByMarket] = useState<
    Record<string, PendingBet | undefined>
  >({});
  const [reveals, setReveals] = useState<RevealVM[]>([]);
  const [closedMarkets, setClosedMarkets] = useState<ClosedMarketVM[]>([]);
  const [catchingUp, setCatchingUp] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<FeedMode>(mode);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [pointsPools, setPointsPools] = useState<
    Record<string, PointsMarketSnapshot>
  >({});

  // ---- refs that must survive re-renders / be read inside async callbacks ----
  const pendingByMarketRef = useRef<Record<string, PendingBet | undefined>>({});
  pendingByMarketRef.current = pendingByMarket;
  const pendingMarketQuestionRef = useRef("");
  const gameRef = useRef<GameState | null>(null);
  gameRef.current = game;
  // OFFLINE: the live engine + the id of the market currently on screen. Held in
  // refs so placeBet can route the human's bet through the SAME engine the loop
  // is driving, without re-running the (heavy) setup effect.
  const engineRef = useRef<MarketEngine | null>(null);
  const openMarketIdRef = useRef<string | null>(null);
  // LIVE: the active socket so placeBet can send a `bet` frame.
  const liveSocketRef = useRef<FeedSocket | null>(null);
  /** False once we see a live open market after connect — historic replay is catch-up. */
  const catchingUpRef = useRef(true);
  const clearToast = useCallback(() => setToast(null), []);
  const market = markets[0] ?? null;
  const pending = market ? (pendingByMarket[market.id] ?? null) : null;

  const upsertMarket = useCallback((next: MarketVM) => {
    setMarkets((prev) => {
      const idx = prev.findIndex((m) => m.id === next.id);
      if (idx < 0) return [...prev, next].sort((a, b) => a.openedAt - b.openedAt);
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...next, subtitle: next.subtitle || copy[idx].subtitle };
      return copy;
    });
  }, []);

  const patchMarket = useCallback((marketId: string, patch: Partial<MarketVM>) => {
    setMarkets((prev) =>
      prev.map((m) => (m.id === marketId ? { ...m, ...patch } : m)),
    );
  }, []);

  const removeMarket = useCallback((marketId: string) => {
    setMarkets((prev) => prev.filter((m) => m.id !== marketId));
  }, []);

  const setPendingForMarket = useCallback((bet: PendingBet | null) => {
    if (!bet) return;
    const next = { ...pendingByMarketRef.current, [bet.marketId]: bet };
    pendingByMarketRef.current = next;
    setPendingByMarket(next);
  }, []);

  const clearPendingForMarket = useCallback((marketId: string) => {
    if (!pendingByMarketRef.current[marketId]) return;
    const next = { ...pendingByMarketRef.current };
    delete next[marketId];
    pendingByMarketRef.current = next;
    setPendingByMarket(next);
  }, []);

  /** Flatten an engine Market into the UI's MarketVM (odds recomputed from pool). */
  const toVM = useCallback((m: Market): MarketVM => {
    const yes = m.pool.yes;
    const no = m.pool.no;
    const gross = yes + no;
    const rake = pointsMode ? POINTS_RAKE : RAKE;
    const net = gross * (1 - rake);
    const vm: MarketVM = {
      id: m.id,
      question: m.question,
      subtitle: "",
      slot: m.slot,
      team: m.team,
      phase:
        m.status === "open"
          ? "open"
          : m.status === "locked"
            ? "locked"
            : "resolved",
      oddsYes: yes > 0 ? net / yes : 1,
      oddsNo: no > 0 ? net / no : 1,
      pool: gross,
      yesShare: gross > 0 ? (100 * yes) / gross : 50,
      participants: m.bets ? new Set(m.bets.map((b) => b.userId)).size : 0,
      openedAt: m.openedAt,
      lockAt: m.lockAt,
      windowMs: m.windowMs,
      resolveWindowMs: m.resolveWindowMs,
      resolveAt: m.resolveAt,
      ...(m.onChain && !pointsMode ? { onChain: m.onChain } : {}),
    };
    if (pointsMode) {
      const snap = pointsPools[m.id];
      if (snap) {
        const pg = snap.poolYes + snap.poolNo;
        return {
          ...vm,
          oddsYes: snap.oddsYes,
          oddsNo: snap.oddsNo,
          pool: pg,
          yesShare: snap.yesShare,
          participants: snap.participants,
          onChain: undefined,
        };
      }
    }
    return vm;
  }, [pointsMode, pointsPools]);

  const teamWord = useCallback((team: Market["team"]): string => {
    const g = gameRef.current;
    if (team === "home") return g?.home.name ?? "Home";
    if (team === "away") return g?.away.name ?? "Away";
    return "They";
  }, []);

  /** Build the reveal view-model from a settlement, for OUR user only. */
  const buildReveal = useCallback(
    (m: Market, settlement: Settlement): RevealVM | null => {
      const p = pendingByMarketRef.current[m.id];
      if (!p || p.marketId !== m.id) return null; // user didn't bet this round
      const outcome: Outcome = settlement.outcome;
      const mine = settlement.payouts.find(
        (x) => x.userId === USER_ID && x.side === p.side,
      );
      const won = outcome !== "VOID" && !!mine?.won;
      const payout = outcome === "VOID" ? p.stake : (mine?.payout ?? 0);
      return {
        marketId: m.id,
        question: m.question,
        team: m.team,
        side: p.side,
        stake: p.stake,
        payoutMult: p.stake > 0 ? payout / p.stake : 0,
        outcome,
        won,
        payout,
      };
    },
    [],
  );

  const enqueueReveal = useCallback((r: RevealVM) => {
    setReveals((prev) => {
      if (prev.some((item) => item.marketId === r.marketId)) return prev;
      return [...prev, r];
    });
  }, []);

  /** Snapshot a settled market for the session history rail. */
  const recordClosedMarket = useCallback((m: Market) => {
    if (!m.settlement) return;
    const yes = m.pool.yes;
    const no = m.pool.no;
    const gross = yes + no;
    const net = gross * (1 - RAKE);
    const p = pendingByMarketRef.current[m.id];
    const userSide =
      p && p.marketId === m.id ? p.side : undefined;
    const closed: ClosedMarketVM = {
      marketId: m.id,
      question: m.question,
      outcome: m.settlement.outcome,
      oddsYes: yes > 0 ? net / yes : 1,
      oddsNo: no > 0 ? net / no : 1,
      poolYes: yes,
      poolNo: no,
      poolTotal: gross,
      yesShare: gross > 0 ? (100 * yes) / gross : 50,
      settledAt: Date.now(),
      ...(userSide ? { userSide } : {}),
    };
    setClosedMarkets((prev) =>
      prev.some((item) => item.marketId === closed.marketId)
        ? prev
        : [closed, ...prev],
    );
  }, []);

  // ================================================================
  // OFFLINE engine: SimMatch + MarketEngine, pumped by a tick loop.
  // ================================================================
  useEffect(() => {
    if (mode !== "offline") return;
    setEffectiveMode("offline");
    setFallbackNotice(null);
    setCatchingUp(false);
    catchingUpRef.current = false;

    let cancelled = false;
    const startAt = Date.now();
    const sim = new SimMatch({ startAt });
    const engine = new MarketEngine({ rake: RAKE, baseSeed: BASE_SEED });
    engineRef.current = engine;
    const ctx = {
      homeName: sim.state.home.name,
      awayName: sim.state.away.name,
    };

    setGame({ ...sim.state });
    setCommentary("Kickoff — the match is underway!");

    let openMarket: Market | null = null;
    let bots: BotRunner | null = null;
    // sequenceId -> marketId, so a later goal/miss resolves the right market.
    const seqToMarket = new Map<string, string>();
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    // Engine -> UI: every pool change (bot OR human bet) re-flattens the VM so
    // odds + the split bar move live.
    const offUpdate = engine.on("update", (m) => {
      if (cancelled || m.id !== openMarketIdRef.current) return;
      upsertMarket(toVM(m));
    });

    // Engine -> UI: a resolved/void market produces the reveal + clears the card.
    const offResolve = engine.on("resolve", (m) => {
      if (cancelled || !m.settlement) return;
      recordClosedMarket(m);
      bots?.stop();
      const r = buildReveal(m, m.settlement);
      if (r) enqueueReveal(r);
      clearPendingForMarket(m.id);
      openMarket = null;
      openMarketIdRef.current = null;
      removeMarket(m.id);
    });

    const lockMarket = (m: Market) => {
      if (cancelled) return;
      engine.lock(m.id);
      bots?.stop(); // no more crowd money once betting closes
      patchMarket(m.id, { phase: "locked" });
      setCommentary("Bets are in. Here it comes…");
      safetyTimer = setTimeout(() => {
        const live = engine.get(m.id);
        if (live && live.status === "locked") engine.resolve(m.id, "VOID");
      }, OFFLINE_RESOLVE_SAFETY_MS);
    };

    const handleEvent = (ev: FeedEvent) => {
      if (cancelled) return;
      setCommentary(ev.text);

      // Goal -> scoreboard. (The clock is advanced by the tick loop below.)
      if (ev.type === "goal" && ev.team) {
        sim.applyGoal(ev.team);
        setGame({ ...sim.state });
      }

      // Lifecycle flips: half time, full time, and the next kickoff must reach
      // the UI so the match screen can show/clear its HT + FT states. The looping
      // sim cycles through these each match.
      if (
        ev.type === "final" ||
        ev.type === "halftime" ||
        ev.type === "kickoff"
      ) {
        setGame({ ...sim.state });
      }

      // (a) Does this event RESOLVE the correlated market? (goal/miss + seqId)
      const outcome = outcomeFromEvent(ev);
      const seqId =
        typeof ev.meta?.sequenceId === "string"
          ? ev.meta.sequenceId
          : undefined;
      if (outcome && seqId) {
        const marketId = seqToMarket.get(seqId);
        if (marketId) {
          const m = engine.get(marketId);
          if (m && (m.status === "open" || m.status === "locked"))
            engine.resolve(marketId, outcome);
          seqToMarket.delete(seqId);
        }
        return;
      }

      // (b) Is this a BETTABLE moment? Open a market (only one card at a time).
      if (openMarket) return;
      const trigger = triggerFromEvent(ev, ctx);
      if (!trigger) return;
      const m = engine.openMarket(trigger);
      openMarket = m;
      openMarketIdRef.current = m.id;
      if (seqId) seqToMarket.set(seqId, m.id);
      upsertMarket({ ...toVM(m), subtitle: ev.text });
      bots = runBots(engine, m); // crowd starts trickling in
    };

    // The tick loop: pull due events; tick the match clock; lock when elapsed.
    let lastClock = sim.state.clock;
    let lastStatus = sim.state.status;
    const loop = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      for (const ev of sim.due(now)) handleEvent(ev);

      // Advance the display clock smoothly (~1' per 900ms wall), pushing to the
      // UI when the minute string OR the lifecycle status (live/halftime/final)
      // changes — so the HT/FT badge flips even if the clock is steady.
      const clock = `${Math.min(90, Math.floor((now - startAt) / 900))}'`;
      if (clock !== lastClock || sim.state.status !== lastStatus) {
        lastClock = clock;
        lastStatus = sim.state.status;
        sim.setClock(clock);
        setGame({ ...sim.state });
      }

      if (
        openMarket &&
        now >= openMarket.lockAt &&
        engine.get(openMarket.id)?.status === "open"
      ) {
        lockMarket(openMarket);
      }
    }, 120);

    return () => {
      cancelled = true;
      clearInterval(loop);
      if (safetyTimer) clearTimeout(safetyTimer);
      bots?.stop();
      offUpdate();
      offResolve();
      engineRef.current = null;
      openMarketIdRef.current = null;
    };
    // toVM/buildReveal/teamWord are stable (read live state via refs). We only
    // (re)build the engine when the mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ================================================================
  // LIVE: WebSocket to the feed service. RECONNECTS on drop — it never silently
  // switches to the mock sim (that's only for an explicit "demo" mode choice).
  // ================================================================
  useEffect(() => {
    if (mode !== "live") return;

    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setEffectiveMode("live");
    setFallbackNotice(null);
    setCatchingUp(true);
    catchingUpRef.current = true;
    setCommentary("Connecting to live feed…");

    const onDrop = (reason: string) => {
      if (cancelled) return;
      const pendingBets = Object.values(pendingByMarketRef.current).filter(
        (p): p is PendingBet => !!p,
      );
      if (pendingBets.length > 0) {
        if (pointsMode) {
          setPendingByMarket({});
        } else {
          const refund = pendingBets.reduce((sum, p) => sum + p.stake, 0);
          store.credit(refund);
          setPendingByMarket({});
        }
        setToast("Connection lost — bet refunded");
      }
      // Stay in LIVE and RETRY the real feed (the user chose live) — do NOT drop
      // to the mock sim. Back off, capped, so it recovers when the feed returns.
      attempts += 1;
      setFallbackNotice(`Live feed unavailable (${reason}) — reconnecting…`);
      setCommentary("Reconnecting to live feed…");
      const delay = Math.min(8000, 1500 * Math.min(attempts, 5));
      retryTimer = setTimeout(() => {
        if (!cancelled) connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      const socket = connectFeed(liveUrl, {
        onOpen: () => {
          if (cancelled) return;
          attempts = 0;
          setFallbackNotice(null);
          setCatchingUp(true);
          catchingUpRef.current = true;
          setReveals([]);
          socket.send({ t: "hello", userId: USER_ID });
          // Join the points system in BOTH modes so real-mode bettors land on the
          // one global leaderboard and receive points_settle on every real bet.
          socket.send({
            t: "points_hello",
            userId: pointsId,
            name: pointsName,
          });
          setCommentary("Live — waiting for the next moment…");
        },
        onClose: (reason) => onDrop(reason),
        onMessage: (msg) => {
          if (cancelled) return;
          switch (msg.t) {
            case "game":
              setGame((prev) => {
                if (prev?.gameId && prev.gameId !== msg.game.gameId) {
                  setClosedMarkets([]);
                  setReveals([]);
                  setMarkets([]);
                  setPendingByMarket({});
                  setMomentum(null);
                  setMomentumLean(null);
                }
                return msg.game;
              });
              // Between halves / at full time nobody's pressing — rest the bar.
              if (msg.game.status === "halftime" || msg.game.status === "final") {
                setMomentum(null);
                setMomentumLean(null);
              }
              break;
            case "commentary":
              setCommentary(msg.text);
              break;
            case "momentum":
              setMomentum(msg.bar);
              // Continuous lean from the raw pressure values. Even when `bar` stays
              // pinned to one side, home/away keep shifting, so the bar keeps moving.
              {
                const total = msg.home + msg.away;
                setMomentumLean(total > 0 ? msg.away / total : 0.5);
              }
              break;
            case "market_open":
              catchingUpRef.current = false;
              setCatchingUp(false);
              if (pointsMode) {
                setPointsPools((prev) => ({
                  ...prev,
                  [msg.market.id]: {
                    marketId: msg.market.id,
                    poolYes: 0,
                    poolNo: 0,
                    oddsYes: 1,
                    oddsNo: 1,
                    yesShare: 50,
                    participants: 0,
                  },
                }));
              }
              upsertMarket({ ...toVM(msg.market), subtitle: msg.market.question });
              break;
            case "market_update":
              upsertMarket(toVM(msg.market));
              break;
            case "market_lock":
              patchMarket(msg.market.id, { phase: "locked" });
              setCommentary("Bets are in. Here it comes…");
              break;
            case "market_resolve": {
              const settlement = msg.market.settlement;
              recordClosedMarket(msg.market);
              const hadBet = !!pendingByMarketRef.current[msg.market.id];
              if (hadBet) pendingMarketQuestionRef.current = msg.market.question;
              if (settlement && !catchingUpRef.current && !pointsMode) {
                const r = buildReveal(msg.market, settlement);
                if (r) enqueueReveal(r);
              }
              if (hadBet && !pointsMode) {
                clearPendingForMarket(msg.market.id);
              } else if (!hadBet && settlement?.outcome === "VOID") {
                setToast("Market voided — unfair timing, no bets taken");
              }
              if (pointsMode) {
                setPointsPools((prev) => {
                  const next = { ...prev };
                  delete next[msg.market.id];
                  return next;
                });
              }
              removeMarket(msg.market.id);
              break;
            }
            case "points_state":
              // Our cross-mode score — keyed by pointsId (pointsUserId in paper,
              // USER_ID in real), so it updates in both modes.
              if (msg.userId === pointsId) {
                store.setPointsState(msg.balance, msg.rank);
              }
              break;
            case "points_leaderboard":
              store.setPointsLeaderboard(msg.players);
              break;
            case "points_market_update":
              setPointsPools((prev) => ({
                ...prev,
                [msg.snapshot.marketId]: msg.snapshot,
              }));
              patchMarket(msg.snapshot.marketId, {
                oddsYes: msg.snapshot.oddsYes,
                oddsNo: msg.snapshot.oddsNo,
                pool: msg.snapshot.poolYes + msg.snapshot.poolNo,
                yesShare: msg.snapshot.yesShare,
                participants: msg.snapshot.participants,
              });
              break;
            case "points_settle": {
              if (msg.userId !== pointsId) break;
              // Cross-mode score update — applies in BOTH modes.
              store.setPointsState(msg.balance, pointsRank);
              // The paper-pool reveal is driven by points_settle (the paper bet's
              // payout). In REAL mode the reveal/pending is owned by market_resolve
              // (real-$ settlement) — points_settle there only adjusts the score,
              // so leave the real-money pending bet alone.
              if (!pointsMode) break;
              const p = pendingByMarketRef.current[msg.marketId];
              if (p && p.marketId === msg.marketId) {
                const won =
                  msg.outcome !== "VOID" && msg.payout > p.stake;
                const payout =
                  msg.outcome === "VOID" ? p.stake : msg.payout;
                enqueueReveal({
                  marketId: msg.marketId,
                  question: pendingMarketQuestionRef.current || "Play moment",
                  team: undefined,
                  side: p.side,
                  stake: p.stake,
                  payoutMult: p.stake > 0 ? payout / p.stake : 0,
                  outcome: msg.outcome,
                  won,
                  payout,
                });
                clearPendingForMarket(msg.marketId);
              }
              break;
            }
            case "bet_rejected": {
              const p = pendingByMarketRef.current[msg.marketId];
              if (msg.userId === USER_ID && p && p.marketId === msg.marketId) {
                store.credit(msg.stake);
                clearPendingForMarket(msg.marketId);
                const reason = msg.reason ?? "";
                setToast(
                  /window|closing/i.test(reason)
                    ? "Betting closed — stake refunded"
                    : "Too close to the action — bet refunded",
                );
              }
              break;
            }
            case "points_bet_rejected": {
              const p = pendingByMarketRef.current[msg.marketId];
              if (msg.userId === pointsUserId && p && p.marketId === msg.marketId) {
                clearPendingForMarket(msg.marketId);
                const reason = msg.reason ?? "";
                setToast(
                  /not enough/i.test(reason)
                    ? "Not enough points"
                    : /window|closing/i.test(reason)
                      ? "Betting closed — stake refunded"
                      : "Too close to the action — bet refunded",
                );
              }
              break;
            }
          }
        },
      });
      liveSocketRef.current = socket;
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      liveSocketRef.current?.close();
      liveSocketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, liveUrl, pointsMode, pointsUserId, pointsName]);

  // ================================================================
  // placeBet — shared by both modes. Odds shown here are indicative only.
  // ================================================================
  const placeBet = useCallback(
    (side: Side, stake: number, marketId?: string): number | null => {
      const m = marketId
        ? markets.find((item) => item.id === marketId)
        : market;
      if (!m || m.phase !== "open") return null; // window closed
      if (Date.now() >= bettingClosesAt(m.lockAt, m.windowMs)) return null;
      if (pendingByMarketRef.current[m.id]) return null; // one bet per market
      const pendingStake = Object.values(pendingByMarketRef.current).reduce(
        (sum, p) => sum + (p?.stake ?? 0),
        0,
      );
      const spendable = pointsMode
        ? store.pointsBalance - pendingStake
        : store.balance;
      if (stake > spendable) {
        setToast(pointsMode ? "Not enough points" : "Not enough balance");
        return null;
      }

      let estimatedMult: number;
      if (effectiveMode === "offline") {
        const engine = engineRef.current;
        if (!engine) return null;
        estimatedMult = indicativeQuote(
          { yes: m.pool * (m.yesShare / 100), no: m.pool * (1 - m.yesShare / 100) },
          side,
          stake,
          RAKE,
        ).multiple;
        try {
          engine.placeBet(m.id, USER_ID, side, stake);
        } catch {
          return null; // locked between render and tap — reject cleanly
        }
        setPendingForMarket({
          marketId: m.id,
          side,
          stake,
          estimatedMult,
        });
      } else {
        // LIVE: the server owns the pool. The multiple the user sees is only an
        // estimate; authoritative payout comes back in market_resolve.
        estimatedMult = side === "YES" ? m.oddsYes : m.oddsNo;
        const bet: PendingBet = {
          marketId: m.id,
          side,
          stake,
          estimatedMult,
        };
        pendingByMarketRef.current = {
          ...pendingByMarketRef.current,
          [m.id]: bet,
        };
        const sent = pointsMode
          ? (liveSocketRef.current?.send({
              t: "points_bet",
              marketId: m.id,
              side,
              stake,
              userId: pointsUserId,
            }) ?? false)
          : (liveSocketRef.current?.send({
              t: "bet",
              marketId: m.id,
              side,
              stake,
              userId: USER_ID,
            }) ?? false);
        if (!sent) {
          clearPendingForMarket(m.id);
          setToast("Connection lost — bet not placed");
          return null;
        }
        if (!pointsMode) {
          store.debit(stake);
        }
        setPendingForMarket(bet);
      }

      setToast(`Bet ${side} · est. ${multiple(estimatedMult)}`);
      return estimatedMult;
    },
    [
      market,
      markets,
      effectiveMode,
      store,
      pointsMode,
      pointsUserId,
      setPendingForMarket,
    ],
  );

  // ================================================================
  // acknowledgeReveal — user tapped one cover; pay out + record history.
  // ================================================================
  const acknowledgeReveal = useCallback((marketId: string) => {
    const reveal = reveals.find((item) => item.marketId === marketId);
    if (!reveal) return;
    if (reveal.won || reveal.outcome === "VOID") {
      if (!pointsMode) store.credit(reveal.payout);
    }
    // Write a full BetRow (payout multiple + question) into the unified ledger, so the
    // Profile screen reads the real bet, not the lossy legacy HistoryRow shape.
    const row: BetRow = {
      kind: "bet",
      id: betRowId(),
      marketId: reveal.marketId,
      gameId: game?.gameId, // scope the match "YOUR RUN" rail to this game only
      label: `${reveal.side} · ${teamWord(reveal.team)} attack`,
      question: reveal.question,
      side: reveal.side,
      stake: reveal.stake,
      payoutMult: reveal.payoutMult,
      outcome: reveal.outcome,
      won: reveal.won,
      delta:
        reveal.outcome === "VOID"
          ? 0
          : reveal.won
            ? reveal.payout
            : -reveal.stake,
      at: Date.now(),
    };
    store.addBet(row);
    setReveals((prev) => prev.filter((item) => item.marketId !== marketId));
    clearPendingForMarket(reveal.marketId);
  }, [reveals, store, teamWord, game, pointsMode, clearPendingForMarket]);

  const activeReveal = catchingUp ? null : (reveals[0] ?? null);
  const historicMarkets = closedMarkets.filter(
    (m) => !reveals.some((r) => r.marketId === m.marketId),
  );

  return {
    game,
    commentary,
    momentum,
    momentumLean,
    markets,
    market,
    pendingByMarket,
    pending,
    reveals: catchingUp ? [] : reveals,
    activeReveal,
    historicMarkets,
    catchingUp,
    effectiveMode,
    fallbackNotice,
    placeBet,
    acknowledgeReveal,
    toast,
    clearToast,
  };
}
