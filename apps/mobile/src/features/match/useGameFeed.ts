import { useCallback, useEffect, useRef, useState } from "react";
import {
  MarketEngine,
  SimMatch,
  indicativeQuote,
  triggerFromEvent,
  outcomeFromEvent,
  isGoalQuestionKind,
  POINTS_RAKE,
  type FeedEvent,
  type GameState,
  type Market,
  type Outcome,
  type PointsMarketSnapshot,
  type Settlement,
  type Side,
} from "@golazo/core";
import { sideDisplayLabel } from "./marketMeta";
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
 *   OFFLINE (Profile → Demo match, zero backend)
 *     SimMatch (the "feed") + a local MarketEngine. On every tick we:
 *       sim.due(now) ─▶ triggerFromEvent ─▶ engine.openMarket ─▶ runBots
 *       at lockAt:      engine.lock
 *       on goal/miss:   engine.resolve (kind-aware YES/NO, not blind VOID)
 *     The attack and its resolving goal/miss are correlated by meta.sequenceId.
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
  /** Last few play-by-play lines (newest last) — powers the live ticker on the
   *  between-moments idle card so the wait never feels dead. */
  commentaryLog: string[];
  /** The agent's live read of who's pressing — drives the momentum bar. */
  momentum: "home" | "away" | null;
  /** Continuous lean toward a side in [0..1] (0 = home/left, 1 = away/right, 0.5 =
   *  even). Lets the bar move smoothly with the run of play; null = no read yet. */
  momentumLean: number | null;
  /** Cosmetic "market incoming" countdown in ms (null = nothing pending). */
  incomingEtaMs: number | null;
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

/**
 * Offline demo resolution — mirrors the live engine where possible. The sim
 * correlates resolver events by sequenceId (no ESPN lag), so a miss on a corner
 * market is a confident NO, not a stuck lock → VOID.
 */
function offlineOutcomeForEvent(
  ev: FeedEvent,
  kind: string,
): Outcome | null {
  if (isGoalQuestionKind(kind)) {
    if (ev.type === 'goal') return 'YES';
    if (ev.type === 'miss' || ev.type === 'play_end') return 'NO';
    return null;
  }
  if (kind === 'penalty_awarded') {
    if (ev.type === 'penalty') return 'YES';
    return null;
  }
  if (kind === 'red_card_given') {
    if (ev.type === 'red_card') return 'YES';
    return null;
  }
  return outcomeFromEvent(ev, kind) === 'YES' ? 'YES' : null;
}

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
  // A rolling buffer of the last few real play-by-play lines (not status messages),
  // de-duped, for the idle card's live ticker.
  const [commentaryLog, setCommentaryLog] = useState<string[]>([]);
  const recordPlay = useCallback((text: string) => {
    const t = text?.trim();
    if (!t) return;
    setCommentaryLog((log) => (log[log.length - 1] === t ? log : [...log, t].slice(-6)));
  }, []);
  const [momentum, setMomentum] = useState<"home" | "away" | null>(null);
  // CONTINUOUS lean toward a side in [0..1]: 0 = all home (left), 1 = all away
  // (right), 0.5 = even. Derived from the server's home/away pressure values so the
  // bar tracks the RUN OF PLAY and visibly moves even while one team stays on top —
  // rather than snapping to 3 fixed positions off the binary leader and looking
  // frozen. Null until the first momentum frame arrives.
  const [momentumLean, setMomentumLean] = useState<number | null>(null);
  // Cosmetic "get ready, a market is incoming" telegraph (ms until it opens), or null when none
  // is pending. Set by the server's market_incoming frame; cleared the instant a market opens.
  const [incomingEtaMs, setIncomingEtaMs] = useState<number | null>(null);
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
  // Mirror the points pools + mode so recordClosedMarket (a [] callback) can read the FINAL
  // points pool at settle, instead of the empty real-money twin pool.
  const pointsPoolsRef = useRef(pointsPools);
  pointsPoolsRef.current = pointsPools;
  const pointsModeRef = useRef(pointsMode);
  pointsModeRef.current = pointsMode;
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
      kind: m.kind,
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
        kind: m.kind,
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

  const netBetDelta = useCallback(
    (
      outcome: Outcome,
      side: Side,
      stake: number,
      payout: number,
      won: boolean,
    ): number => {
      if (outcome === "VOID") return 0;
      return won ? payout - stake : -stake;
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
    // In points mode read the FINAL points pool snapshot — the real-money twin pool is empty
    // here, which is why the settled row showed "0 pts". Points are zero-rake.
    const ptSnap = pointsModeRef.current ? pointsPoolsRef.current[m.id] : undefined;
    const yes = ptSnap ? ptSnap.poolYes : m.pool.yes;
    const no = ptSnap ? ptSnap.poolNo : m.pool.no;
    const gross = yes + no;
    const net = gross * (1 - (ptSnap ? 0 : RAKE));
    const p = pendingByMarketRef.current[m.id];
    const userSide = p && p.marketId === m.id ? p.side : undefined;
    const userStake = p && p.marketId === m.id ? p.stake : undefined;
    const closed: ClosedMarketVM = {
      marketId: m.id,
      question: m.question,
      kind: m.kind,
      outcome: m.settlement.outcome,
      oddsYes: yes > 0 ? net / yes : 1,
      oddsNo: no > 0 ? net / no : 1,
      poolYes: yes,
      poolNo: no,
      poolTotal: gross,
      yesShare: gross > 0 ? (100 * yes) / gross : 50,
      settledAt: Date.now(),
      ...(userSide ? { userSide } : {}),
      ...(userStake ? { userStake } : {}),
      ...(m.voidReason ? { voidReason: m.voidReason } : {}),
    };
    setClosedMarkets((prev) =>
      prev.some((item) => item.marketId === closed.marketId)
        ? prev
        : [closed, ...prev],
    );
  }, []);

  const patchClosedMarket = useCallback(
    (marketId: string, patch: Partial<ClosedMarketVM>) => {
      setClosedMarkets((prev) =>
        prev.map((item) =>
          item.marketId === marketId ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

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
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    // Decaying attacking momentum per side — drives the demo's "spell" markets so the
    // demo showcases the SAME market types the live engine opens (shot/score windows),
    // not just set-pieces.
    let momHome = 0;
    let momAway = 0;
    let lastMomOpenAt = 0;

    const clearDeadlineTimer = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };

    const scheduleDeadlineNo = (marketId: string) => {
      clearDeadlineTimer();
      const live = engine.get(marketId);
      if (!live) return;
      const delay = Math.max(0, live.resolveAt - Date.now());
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        const m = engine.get(marketId);
        if (m && m.status === 'locked') engine.resolve(marketId, 'NO');
      }, delay);
    };

    // Engine -> UI: every pool change (bot OR human bet) re-flattens the VM so
    // odds + the split bar move live.
    const offUpdate = engine.on("update", (m) => {
      if (cancelled || m.id !== openMarketIdRef.current) return;
      upsertMarket(toVM(m));
    });

    // Engine -> UI: a resolved/void market produces the reveal + clears the card.
    const offResolve = engine.on("resolve", (m) => {
      if (cancelled || !m.settlement) return;
      clearDeadlineTimer();
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
      scheduleDeadlineNo(m.id);
    };

    const MOM_W: Record<string, number> = {
      goal: 4,
      dangerous_attack: 3,
      shot: 2.5,
      miss: 2,
      corner: 1.6,
      attack: 1.4,
      free_kick: 1,
    };

    const handleEvent = (ev: FeedEvent) => {
      if (cancelled) return;
      setCommentary(ev.text);
      recordPlay(ev.text);

      // Fold the event into attacking momentum (decay both, add weight to the actor).
      const mw = MOM_W[ev.type];
      if (ev.team && mw) {
        momHome *= 0.8;
        momAway *= 0.8;
        if (ev.team === "home") momHome += mw;
        else momAway += mw;
      }

      // Goal -> scoreboard. (The clock is advanced by the tick loop below.)
      if (ev.type === "goal" && ev.team) {
        sim.applyGoal(ev.team);
        setGame({ ...sim.state });
      }

      if (
        ev.type === "final" ||
        ev.type === "halftime" ||
        ev.type === "kickoff"
      ) {
        setGame({ ...sim.state });
      }

      if (ev.type === "final" && openMarket) {
        const m = engine.get(openMarket.id);
        if (m && (m.status === "open" || m.status === "locked")) {
          clearDeadlineTimer();
          engine.resolve(openMarket.id, "VOID");
        }
      }

      // (a0) Momentum "spell" markets aren't tied to one play — they resolve on any
      // shot/goal/miss by the pressing team (YES), else the deadline sweep (NO).
      if (openMarket) {
        const wm = engine.get(openMarket.id);
        if (
          wm &&
          (wm.status === "open" || wm.status === "locked") &&
          (wm.kind === "shot_in_window" ||
            wm.kind === "score_in_window" ||
            wm.kind === "chance_from_play") &&
          (ev.type === "goal" || ev.type === "shot" || ev.type === "miss") &&
          (!wm.team || ev.team === wm.team)
        ) {
          const decision = offlineOutcomeForEvent(ev, wm.kind);
          if (decision) {
            clearDeadlineTimer();
            engine.resolve(wm.id, decision);
            return;
          }
        }
      }

      // (a) Correlated resolver (goal/miss/play_end) for the market this seq opened.
      const seqId =
        typeof ev.meta?.sequenceId === "string"
          ? ev.meta.sequenceId
          : undefined;
      if (seqId) {
        const marketId = seqToMarket.get(seqId);
        if (marketId) {
          const m = engine.get(marketId);
          if (m && (m.status === "open" || m.status === "locked")) {
            const decision = offlineOutcomeForEvent(ev, m.kind);
            if (decision) {
              clearDeadlineTimer();
              engine.resolve(marketId, decision);
            }
          }
          seqToMarket.delete(seqId);
          return;
        }
      }

      // (b) Is this a BETTABLE moment? Open a market (only one card at a time).
      if (openMarket) return;

      // Momentum "spell" market first — when a side is pressing, open a window market
      // (the lane that dominates the live board). Light pressure → "a SHOT this spell?",
      // a real siege → "to SCORE soon?".
      const momLeader =
        momHome > momAway ? "home" : momAway > momHome ? "away" : null;
      const momIntensity =
        momLeader === "home" ? momHome : momLeader === "away" ? momAway : 0;
      if (momLeader && momIntensity >= 2.0 && Date.now() - lastMomOpenAt > 8000) {
        const teamName = momLeader === "home" ? ctx.homeName : ctx.awayName;
        const big = momIntensity >= 5.0;
        const m = engine.openMarket({
          gameId: ev.gameId,
          kind: big ? "score_in_window" : "shot_in_window",
          slot: "window",
          team: momLeader,
          question: big
            ? `${teamName} laying siege — to SCORE soon?`
            : `${teamName} on top — a SHOT this spell?`,
          windowMs: 9000,
          trueProb: big ? 0.22 : 0.4,
          resolveWindowMs: 16000,
        });
        openMarket = m;
        openMarketIdRef.current = m.id;
        lastMomOpenAt = Date.now();
        upsertMarket({ ...toVM(m), subtitle: ev.text });
        bots = runBots(engine, m);
        return;
      }

      const trigger = triggerFromEvent(ev, ctx);
      if (!trigger) return;
      const m = engine.openMarket({
        ...trigger,
        // Tight deadline backup — sim resolves ~1–2s after lock, not 60s.
        resolveWindowMs: trigger.windowMs + 5_000,
      });
      openMarket = m;
      openMarketIdRef.current = m.id;
      const openerSeq =
        typeof ev.meta?.sequenceId === "string" ? ev.meta.sequenceId : undefined;
      if (openerSeq) seqToMarket.set(openerSeq, m.id);
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

      if (openMarket) {
        const live = engine.get(openMarket.id);
        if (live && live.status === "locked" && now >= live.resolveAt) {
          clearDeadlineTimer();
          engine.resolve(openMarket.id, "NO");
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      clearInterval(loop);
      clearDeadlineTimer();
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
      // Game's over: a quiet/closed socket at full time is the END, not a fault. Keep the
      // clean full-time card instead of painting a grey "reconnecting…" banner over it.
      if (gameRef.current?.status === "final") {
        setFallbackNotice(null);
        return;
      }
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
                // Hold full time: once this match is final, ignore the server's post-match
                // EmptyFeed/reset frame (empty or same gameId) so the clean full-time card
                // isn't wiped back to a grey idle board. Only a genuinely new fixture
                // (a different, non-empty gameId) takes over.
                if (
                  prev?.status === "final" &&
                  (!msg.game.gameId || msg.game.gameId === prev.gameId)
                ) {
                  return prev;
                }
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
              recordPlay(msg.text);
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
            case "market_incoming":
              setIncomingEtaMs(msg.etaMs);
              break;
            case "market_open":
              catchingUpRef.current = false;
              setCatchingUp(false);
              setIncomingEtaMs(null); // the wait is over — the card is here

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
              const pending = pendingByMarketRef.current[msg.market.id];
              const hadBet = !!pending;
              recordClosedMarket(msg.market);
              if (hadBet) pendingMarketQuestionRef.current = msg.market.question;
              // REAL mode only: derive the P/L from the on-chain settlement here. In POINTS
              // mode this market's pool is the (empty) real-money twin — the points user isn't
              // in its payouts, so it would patch a WRONG userDelta (e.g. +0 on a win). Points
              // P/L is owned by the dedicated points_settle handler below.
              if (pending && settlement && !pointsMode) {
                const bettorId = USER_ID;
                const won =
                  settlement.outcome !== "VOID" &&
                  pending.side === settlement.outcome;
                const mine = settlement.payouts.find(
                  (x) => x.userId === bettorId && x.side === pending.side,
                );
                const payout =
                  settlement.outcome === "VOID"
                    ? pending.stake
                    : (mine?.payout ?? 0);
                patchClosedMarket(msg.market.id, {
                  userStake: pending.stake,
                  userSide: pending.side,
                  kind: msg.market.kind,
                  userDelta: netBetDelta(
                    settlement.outcome,
                    pending.side,
                    pending.stake,
                    payout,
                    won,
                  ),
                });
              }
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
              // REAL mode: points_settle is only the cross-mode score — apply it now (the
              // real-money reveal/pending is owned by market_resolve). POINTS mode: the
              // balance is GIVEN on the REVEAL tap (the "claim"), matching real money — so we
              // DEFER the balance update into the reveal instead of crediting on settle.
              if (!pointsMode) {
                store.setPointsState(msg.balance, pointsRank);
                break;
              }
              const p = pendingByMarketRef.current[msg.marketId];
              if (p && p.marketId === msg.marketId) {
                // WIN is side===outcome — NOT payout>stake. In a one-sided pool (a solo
                // tester, zero points rake) a winning payout EQUALS the stake, so
                // payout>stake wrongly read every win as a MISS.
                const won = msg.outcome !== "VOID" && p.side === msg.outcome;
                const payout =
                  msg.outcome === "VOID" ? p.stake : msg.payout;
                const userDelta = netBetDelta(
                  msg.outcome,
                  p.side,
                  p.stake,
                  payout,
                  won,
                );
                patchClosedMarket(msg.marketId, {
                  userStake: p.stake,
                  userDelta,
                });
                enqueueReveal({
                  marketId: msg.marketId,
                  question: pendingMarketQuestionRef.current || "Play moment",
                  kind: undefined,
                  team: undefined,
                  side: p.side,
                  stake: p.stake,
                  payoutMult: p.stake > 0 ? payout / p.stake : 0,
                  outcome: msg.outcome,
                  won,
                  payout,
                  claimBalance: msg.balance, // credited to the displayed balance ON REVEAL
                });
                clearPendingForMarket(msg.marketId);
              } else {
                // Nothing of ours to reveal/claim on this market — just sync the score.
                store.setPointsState(msg.balance, pointsRank);
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
              if (msg.userId !== pointsId) break;
              if (p && p.marketId === msg.marketId) {
                clearPendingForMarket(msg.marketId);
              }
              const reason = msg.reason ?? "";
              setToast(
                /not enough/i.test(reason)
                  ? "Not enough points"
                  : /already pending/i.test(reason)
                    ? "Bet still clearing — hang on"
                    : /window|closing/i.test(reason)
                      ? "Betting closed — stake refunded"
                      : "Too close to the action — bet refunded",
              );
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
      const spendable = pointsMode ? store.pointsBalance : store.balance;
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

      setToast(
        `Bet ${sideDisplayLabel(side, m.kind, m.question)} · est. ${multiple(estimatedMult)}`,
      );
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
      clearPendingForMarket,
    ],
  );

  // ================================================================
  // acknowledgeReveal — user tapped one cover; pay out + record history.
  // ================================================================
  const acknowledgeReveal = useCallback((marketId: string) => {
    const reveal = reveals.find((item) => item.marketId === marketId);
    if (!reveal) return;
    if (pointsMode) {
      // POINTS: the reveal IS the claim — credit the settled balance now (deferred from settle),
      // so points land exactly when you tap, just like claiming a real-money payout.
      if (reveal.claimBalance !== undefined) {
        store.setPointsState(reveal.claimBalance, pointsRank);
      }
    } else if (reveal.won || reveal.outcome === "VOID") {
      store.credit(reveal.payout);
    }
    // Write a full BetRow (payout multiple + question) into the unified ledger, so the
    // Profile screen reads the real bet, not the lossy legacy HistoryRow shape.
    const row: BetRow = {
      kind: "bet",
      id: betRowId(),
      marketId: reveal.marketId,
      gameId: game?.gameId, // scope the match "YOUR RUN" rail to this game only
      label: sideDisplayLabel(reveal.side, reveal.kind, reveal.question),
      question: reveal.question,
      side: reveal.side,
      stake: reveal.stake,
      payoutMult: reveal.payoutMult,
      outcome: reveal.outcome,
      won: reveal.won,
      delta: netBetDelta(
        reveal.outcome,
        reveal.side,
        reveal.stake,
        reveal.payout,
        reveal.won,
      ),
      at: Date.now(),
    };
    store.addBet(row);
    setClosedMarkets((prev) => {
      const idx = prev.findIndex((m) => m.marketId === marketId);
      if (idx < 0) return prev;
      const item = { ...prev[idx], revealedAt: Date.now() };
      return [item, ...prev.filter((_, i) => i !== idx)];
    });
    setReveals((prev) => prev.filter((item) => item.marketId !== marketId));
    clearPendingForMarket(reveal.marketId);
  }, [reveals, store, teamWord, game, pointsMode, pointsRank, clearPendingForMarket]);

  const activeReveal = catchingUp ? null : (reveals[0] ?? null);
  const historicMarkets = closedMarkets
    .filter((m) => !reveals.some((r) => r.marketId === m.marketId))
    .sort(
      (a, b) =>
        (b.revealedAt ?? b.settledAt) - (a.revealedAt ?? a.settledAt),
    );

  return {
    game,
    commentary,
    commentaryLog,
    momentum,
    momentumLean,
    incomingEtaMs,
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
