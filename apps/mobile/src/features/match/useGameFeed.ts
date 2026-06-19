import { useCallback, useEffect, useRef, useState } from "react";
import {
  MarketEngine,
  SimMatch,
  indicativeQuote,
  triggerFromEvent,
  outcomeFromEvent,
  type FeedEvent,
  type GameState,
  type Market,
  type Outcome,
  type Settlement,
  type Side,
} from "@golazo/core";
import { useStore } from "@/state/store";
import { runBots, type BotRunner } from "@/lib/bots";
import { connectFeed, type FeedSocket } from "@/lib/ws";
import { BASE_SEED, RAKE, USER_ID } from "@/lib/config";
import { multiple } from "@/lib/format";
import type {
  BetRow,
  MarketVM,
  PendingBet,
  RevealVM,
  FeedMode,
} from "@/state/types";

/**
 * useGameFeed — the heart of the live loop on the device.
 *
 * It exposes ONE flat view model (scoreboard, commentary, current market,
 * pending bet, reveal queue) plus a `placeBet` action, and runs in two
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
  market: MarketVM | null;
  pending: PendingBet | null;
  reveals: RevealVM[];
  /** Effective mode right now — may be 'offline' even if the user picked 'live'
   *  (i.e. we fell back). */
  effectiveMode: FeedMode;
  /** Set when we auto-fell-back from live, so the UI can show a banner. */
  fallbackNotice: string | null;
}

export interface GameFeedApi extends GameFeedVM {
  /** Tap YES/NO. Returns the estimated multiple (for the toast) or null if rejected. */
  placeBet: (side: Side, stake: number) => number | null;
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
  const { mode, liveUrl } = store;

  // ---- view-model state (what the screen draws) ----
  const [game, setGame] = useState<GameState | null>(null);
  const [commentary, setCommentary] = useState("Connecting to the match…");
  const [market, setMarket] = useState<MarketVM | null>(null);
  const [pending, setPending] = useState<PendingBet | null>(null);
  const [reveals, setReveals] = useState<RevealVM[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<FeedMode>(mode);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  // ---- refs that must survive re-renders / be read inside async callbacks ----
  const pendingRef = useRef<PendingBet | null>(null);
  pendingRef.current = pending;
  const gameRef = useRef<GameState | null>(null);
  gameRef.current = game;
  // OFFLINE: the live engine + the id of the market currently on screen. Held in
  // refs so placeBet can route the human's bet through the SAME engine the loop
  // is driving, without re-running the (heavy) setup effect.
  const engineRef = useRef<MarketEngine | null>(null);
  const openMarketIdRef = useRef<string | null>(null);
  // LIVE: the active socket so placeBet can send a `bet` frame.
  const liveSocketRef = useRef<FeedSocket | null>(null);

  const clearToast = useCallback(() => setToast(null), []);

  /** Flatten an engine Market into the UI's MarketVM (odds recomputed from pool). */
  const toVM = useCallback((m: Market): MarketVM => {
    const yes = m.pool.yes;
    const no = m.pool.no;
    const gross = yes + no;
    const net = gross * (1 - RAKE);
    return {
      id: m.id,
      question: m.question,
      subtitle: "", // caller fills from commentary; preserved on updates
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
      // Distinct bettors in the pool right now (you + the crowd). Real count off
      // the engine/feed market's bets — the public game's "active players".
      participants: m.bets ? new Set(m.bets.map((b) => b.userId)).size : 0,
      openedAt: m.openedAt,
      lockAt: m.lockAt,
      windowMs: m.windowMs,
      ...(m.onChain ? { onChain: m.onChain } : {}),
    };
  }, []);

  const teamWord = useCallback((team: Market["team"]): string => {
    const g = gameRef.current;
    if (team === "home") return g?.home.name ?? "Home";
    if (team === "away") return g?.away.name ?? "Away";
    return "They";
  }, []);

  /** Build the reveal view-model from a settlement, for OUR user only. */
  const buildReveal = useCallback(
    (m: Market, settlement: Settlement): RevealVM | null => {
      const p = pendingRef.current;
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
    setReveals((prev) =>
      prev.some((item) => item.marketId === r.marketId) ? prev : [...prev, r],
    );
  }, []);

  // ================================================================
  // OFFLINE engine: SimMatch + MarketEngine, pumped by a tick loop.
  // ================================================================
  useEffect(() => {
    if (mode !== "offline") return;
    setEffectiveMode("offline");
    setFallbackNotice(null);

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
      setMarket((prev) => ({ ...toVM(m), subtitle: prev?.subtitle ?? "" }));
    });

    // Engine -> UI: a resolved/void market produces the reveal + clears the card.
    const offResolve = engine.on("resolve", (m) => {
      if (cancelled || !m.settlement) return;
      bots?.stop();
      const r = buildReveal(m, m.settlement);
      if (r) enqueueReveal(r);
      if (pendingRef.current?.marketId === m.id) {
        setPending(null);
        pendingRef.current = null;
      }
      openMarket = null;
      openMarketIdRef.current = null;
      setMarket(null);
    });

    const lockMarket = (m: Market) => {
      if (cancelled) return;
      engine.lock(m.id);
      bots?.stop(); // no more crowd money once betting closes
      setMarket((prev) =>
        prev && prev.id === m.id ? { ...prev, phase: "locked" } : prev,
      );
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

      // Lifecycle flips: full time (status -> 'final') and the next kickoff
      // (status -> 'live') must reach the UI so the match screen can show / clear
      // its full-time end state. The looping sim cycles through these each match.
      if (ev.type === "final" || ev.type === "kickoff") {
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
      setMarket({ ...toVM(m), subtitle: ev.text });
      bots = runBots(engine, m); // crowd starts trickling in
    };

    // The tick loop: pull due events; tick the match clock; lock when elapsed.
    let lastClock = sim.state.clock;
    const loop = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      for (const ev of sim.due(now)) handleEvent(ev);

      // Advance the display clock smoothly (~1' per 900ms wall), pushing to the
      // UI only when the minute string actually changes so we don't re-render
      // the scoreboard every 120ms.
      const clock = `${Math.min(90, Math.floor((now - startAt) / 900))}'`;
      if (clock !== lastClock) {
        lastClock = clock;
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
    setCommentary("Connecting to live feed…");

    const onDrop = (reason: string) => {
      if (cancelled) return;
      // A pending live bet whose settlement will never arrive must be refunded.
      const p = pendingRef.current;
      if (p) {
        store.credit(p.stake);
        setPending(null);
        pendingRef.current = null;
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
          socket.send({ t: "hello", userId: USER_ID });
          setCommentary("Live — waiting for the next moment…");
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
            case "market_open":
              setMarket({ ...toVM(msg.market), subtitle: msg.market.question });
              break;
            case "market_update":
              setMarket((prev) =>
                prev && prev.id === msg.market.id
                  ? { ...toVM(msg.market), subtitle: prev.subtitle }
                  : prev,
              );
              break;
            case "market_lock":
              setMarket((prev) =>
                prev && prev.id === msg.market.id
                  ? { ...prev, phase: "locked" }
                  : prev,
              );
              setCommentary("Bets are in. Here it comes…");
              break;
            case "market_resolve": {
              const settlement = msg.market.settlement;
              if (settlement) {
                const r = buildReveal(msg.market, settlement);
                if (r) enqueueReveal(r);
              }
              if (pendingRef.current?.marketId === msg.market.id) {
                setPending(null);
                pendingRef.current = null;
              }
              setMarket(null);
              break;
            }
            case "bet_rejected": {
              // Held bet not accepted (play resolved inside the bet-delay, or the
              // market closed). Refund the optimistic debit.
              const p = pendingRef.current;
              if (msg.userId === USER_ID && p && p.marketId === msg.marketId) {
                store.credit(msg.stake);
                setPending(null);
                pendingRef.current = null;
                setToast("Too close to the action — bet refunded");
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
  }, [mode, liveUrl]);

  // ================================================================
  // placeBet — shared by both modes. Odds shown here are indicative only.
  // ================================================================
  const placeBet = useCallback(
    (side: Side, stake: number): number | null => {
      const m = market;
      if (!m || m.phase !== "open") return null; // window closed
      if (pendingRef.current?.marketId === m.id) return null; // one bet per market
      if (stake > store.balance) {
        setToast("Not enough balance");
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
      } else {
        // LIVE: the server owns the pool. The multiple the user sees is only an
        // estimate; authoritative payout comes back in market_resolve.
        estimatedMult = side === "YES" ? m.oddsYes : m.oddsNo;
        // Only debit if the bet frame was actually transmitted — never take a
        // stake for a bet the server never received.
        const sent =
          liveSocketRef.current?.send({
            t: "bet",
            marketId: m.id,
            side,
            stake,
            userId: USER_ID,
          }) ?? false;
        if (!sent) {
          setToast("Connection lost — bet not placed");
          return null;
        }
      }

      store.debit(stake); // stake taken only after a confirmed placement (offline engine / live send)
      const bet: PendingBet = { marketId: m.id, side, stake, estimatedMult };
      setPending(bet);
      pendingRef.current = bet;
      setToast(`Bet ${side} · est. ${multiple(estimatedMult)}`);
      return estimatedMult;
    },
    [market, effectiveMode, store],
  );

  // ================================================================
  // acknowledgeReveal — user tapped one cover; pay out + record history.
  // ================================================================
  const acknowledgeReveal = useCallback((marketId: string) => {
    const reveal = reveals.find((item) => item.marketId === marketId);
    if (!reveal) return;
    if (reveal.won || reveal.outcome === "VOID") {
      store.credit(reveal.payout); // capped winnings OR full VOID refund
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
    if (pendingRef.current?.marketId === reveal.marketId) {
      setPending(null);
      pendingRef.current = null;
    }
  }, [reveals, store, teamWord, game]);

  return {
    game,
    commentary,
    market,
    pending,
    reveals,
    effectiveMode,
    fallbackNotice,
    placeBet,
    acknowledgeReveal,
    toast,
    clearToast,
  };
}
