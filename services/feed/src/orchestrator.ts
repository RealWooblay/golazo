/**
 * Orchestrator — the loop that runs a live match's betting.
 *
 * Pipeline (this is the file to read to understand the whole service):
 *
 *   feed.poll() ──▶ for each FeedEvent:
 *      • broadcast commentary
 *      • if it's an ATTACK-type "set moment":
 *          ── AI watcher (Claude) decides + phrases ──▶ MarketTrigger (or rules fallback)
 *          ── engine.openMarket(trigger) ──▶ Market
 *          ── BotSwarm fills the pool across the window
 *          ── schedule auto-lock at market.lockAt
 *          ── remember the event's sequenceId so we can correlate the resolution
 *      • if it's a GOAL/MISS resolution:
 *          ── find the open market it resolves (by meta.sequenceId, else newest open)
 *          ── engine.resolve(market, outcomeFromEvent(ev))
 *          ── apply the goal to the scoreline
 *      • if it's a goal with no open market: still update the scoreline.
 *
 *   Safety net: if a market locks and NO resolution arrives within
 *   resolveTimeoutMs, we VOID it (refund everyone). Real money + doubt = never guess.
 *
 * The engine emits open/update/lock/resolve; we subscribe once and turn each into
 * the matching `ServerMessage` broadcast. So bots' bets, users' bets, locks and
 * settlements all flow to the app through one place.
 */

import {
  MarketEngine,
  outcomeFromEvent,
  type ClientMessage,
  type FeedEvent,
  type Market,
  type Team,
} from '@golazo/core';
import type { Config } from './config';
import type { FeedSource } from './feed/index';
import { aiTriggerFromEvents } from './ai/watcher';
import { knobFor } from './ai/marketTuning';
import { BotSwarm, resolveBotConfig } from './bots';
import { createChainOperator, type FeedChainOperator } from './chain';
import { FeedServer } from './server';

/** Per-market bookkeeping the orchestrator keeps alongside the engine's Market. */
interface TrackedMarket {
  marketId: string;
  /** sequenceId of the attack event that opened it, for resolution correlation. */
  sequenceId: string | undefined;
  /** team the attack belongs to, so we know whose score to bump on a goal. */
  team: Team | undefined;
  bots: BotSwarm;
  lockTimer: ReturnType<typeof setTimeout>;
  voidTimer?: ReturnType<typeof setTimeout>;
  /** Per-type window (ms) to wait after lock for a goal/miss before settling NO. */
  resolveWindowMs: number;
  /** User bets being HELD for the bet-delay, keyed by userId (one in flight per user). */
  pending: Map<string, HeldBet>;
  /**
   * u64 seed of this market's on-chain twin (when CHAIN MODE created one). Used to
   * drive lock/resolve on-chain. Undefined when chain is off or init failed.
   */
  marketSeed?: number;
}

/** A user bet held for the bet-delay window before it enters the pool. */
interface HeldBet {
  userId: string;
  side: 'YES' | 'NO';
  stake: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Orchestrator {
  private readonly engine: MarketEngine;
  private readonly server: FeedServer;
  /** Open/locked markets we're still tracking, by market id. */
  private readonly tracked = new Map<string, TrackedMarket>();
  /** Rolling recent events, passed to the AI watcher for context. */
  private readonly recent: FeedEvent[] = [];
  private tickTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  /** Cumulative trade fees (rake) collected for the treasury — the house's revenue. */
  private feesCollected = 0;
  private marketsSettled = 0;

  /** The on-chain settlement mirror. Always present; a no-op when CHAIN MODE is off. */
  private readonly chain: FeedChainOperator;
  /** Operator authority (base58) when chain is active, else null. */
  private readonly chainAuthority: string | null;
  /**
   * Per-boot salt so market seeds don't collide with PDAs created by a prior
   * run (the program rejects re-initializing an existing market PDA). Date.now()
   * is fine here — this is feed runtime, not a deterministic workflow script.
   */
  private readonly bootSalt: number;
  private seedCounter = 0;

  constructor(
    private readonly config: Config,
    private readonly feed: FeedSource,
  ) {
    this.engine = new MarketEngine({
      rake: config.rake,
      baseSeed: 0,
      now: () => Date.now(),
    });

    // The on-chain operator reads its own config from process.env (CHAIN_ENABLED,
    // OPERATOR_KEYPAIR, SOLANA_RPC_URL, GOLAZO_PROGRAM_ID). Inactive → every call
    // is a no-op returning null, so the hot path never depends on Solana.
    this.chain = createChainOperator();
    this.chainAuthority = this.chain.operatorPubkey?.toBase58() ?? null;
    this.bootSalt = Math.floor(Date.now() / 1000) % 100000;

    this.server = new FeedServer({
      port: config.port,
      engine: this.engine,
      getGame: () => this.feed.state(),
      onBet: (msg) => this.handleUserBet(msg),
      getFees: () => ({
        recipient: this.config.feeRecipient,
        rakeBps: Math.round(this.config.rake * 10000),
        collected: this.feesCollected,
        marketsSettled: this.marketsSettled,
      }),
    });

    this.wireEngineBroadcasts();
  }

  /** Bind the server, push an initial game frame, and start the feed loop. */
  async start(): Promise<void> {
    await this.server.listen();
    this.server.broadcast({ t: 'game', game: this.feed.state() });

    // One driving tick: poll the feed, process events. We reuse the ESPN poll
    // interval for the cadence; the sim is cheap so over-polling is harmless.
    const intervalMs = this.feed.kind === 'espn' ? this.config.espnPollMs : 500;
    this.tickTimer = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.tracked.values()) {
      t.bots.cancel();
      clearTimeout(t.lockTimer);
      if (t.voidTimer) clearTimeout(t.voidTimer);
    }
    this.tracked.clear();
    await this.feed.close();
    await this.server.close();
  }

  // -------------------------------------------------------------------------
  // Feed processing
  // -------------------------------------------------------------------------

  /** One iteration: pull events, broadcast a fresh game frame, process each. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    let events: FeedEvent[];
    try {
      events = await this.feed.poll(Date.now());
    } catch {
      return; // a feed blip never breaks the loop
    }
    if (events.length === 0) return;

    // Keep the app's score/clock fresh.
    this.server.broadcast({ t: 'game', game: this.feed.state() });

    for (const ev of events) {
      await this.processEvent(ev);
    }
  }

  private async processEvent(ev: FeedEvent): Promise<void> {
    // Always surface commentary to the app.
    this.server.broadcast({ t: 'commentary', text: ev.text, ts: ev.ts });

    // Maintain rolling context (cap to avoid unbounded growth).
    this.recent.push(ev);
    if (this.recent.length > 12) this.recent.shift();

    const outcome = outcomeFromEvent(ev); // 'YES' (goal) | 'NO' (miss) | null
    if (outcome) {
      this.resolveFromEvent(ev, outcome);
      return;
    }

    // Otherwise this might be a bettable "set moment". The watcher (AI, then
    // rules) decides — and returns null for calm/non-bettable events.
    await this.maybeOpenMarket(ev);
  }

  /**
   * Unique u64 seed for a market's on-chain PDA. `bootSalt * 10000 + counter`
   * stays well under 2^53 (bootSalt < 1e5 → product < 1e9 + counter) so it's an
   * exact JS integer, and the per-boot salt keeps it collision-free across restarts.
   */
  private nextMarketSeed(): number {
    return this.bootSalt * 10000 + ++this.seedCounter;
  }

  /** Ask the watcher; if it returns a trigger, open + seed + bot-fill a market. */
  private async maybeOpenMarket(ev: FeedEvent): Promise<void> {
    // One market on the table at a time — matches the app UX and keeps the live
    // stream legible (no overlapping windows competing for the same goal).
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (m && (m.status === 'open' || m.status === 'locked')) return;
    }

    const game = this.feed.state();
    const trigger = await aiTriggerFromEvents([...this.recent], game, {
      homeName: game.home.name,
      awayName: game.away.name,
    });
    if (!trigger) return;

    // CHAIN MODE: stamp the trigger with an on-chain twin BEFORE opening, so the
    // market_open broadcast carries { marketSeed, authority } through to the app.
    let marketSeed: number | undefined;
    if (this.chain.active && this.chainAuthority) {
      marketSeed = this.nextMarketSeed();
      trigger.onChain = { marketSeed, authority: this.chainAuthority };
    }

    const market = this.engine.openMarket(trigger);

    // Best-effort: create the real on-chain market. NEVER throws on the hot path —
    // any chain hiccup is logged and the off-chain market proceeds unaffected.
    if (marketSeed !== undefined) {
      const seed = marketSeed;
      void this.chain
        .initMarket({
          marketSeed: seed,
          questionText: market.question,
          rakeBps: Math.round(this.config.rake * 10000),
          seedYesLamports: this.config.chainSeedLamports,
          seedNoLamports: this.config.chainSeedLamports,
        })
        .then((res) => {
          if (res) {
            console.log(
              `[golazo/feed] chain initMarket seed=${seed} ` +
                `market=${res.marketPda.toBase58()} sig=${res.signature}`,
            );
          }
        })
        .catch((err) => {
          console.warn(`[golazo/feed] chain initMarket seed=${seed} failed: ${String(err)}`);
        });
    }

    // Spin up bots to make the pool feel alive immediately.
    const bots = new BotSwarm(this.engine, resolveBotConfig({ count: this.config.botCount }));
    bots.start(market);

    // Auto-lock a few seconds before the play resolves (windowMs is sized for that).
    const lockTimer = setTimeout(() => this.lockMarket(market.id), trigger.windowMs);

    this.tracked.set(market.id, {
      marketId: market.id,
      sequenceId: seqIdOf(ev),
      team: ev.team,
      bots,
      lockTimer,
      resolveWindowMs: knobFor(ev.type)?.resolveWindowMs ?? this.config.resolveTimeoutMs,
      pending: new Map(),
      marketSeed,
    });
  }

  /** Lock a market: stop bots, lock the engine, and arm the void safety-net. */
  private lockMarket(marketId: string): void {
    const t = this.tracked.get(marketId);
    if (!t) return;
    t.bots.cancel();
    const m = this.engine.get(marketId);
    if (m && m.status === 'open') this.engine.lock(marketId);

    // Mirror the lock on-chain (best-effort, fire-and-forget — never blocks).
    if (t.marketSeed !== undefined) void this.chain.lockMarket(t.marketSeed);

    // If no goal/miss arrives within the per-type window, settle the goal-question
    // NO (the chance passed) — see settleUnresolved.
    t.voidTimer = setTimeout(() => this.settleUnresolved(marketId), t.resolveWindowMs);
  }

  /**
   * Resolve from a goal/miss event. We correlate to the open market by
   * `meta.sequenceId` (set by both sim and ESPN); if that's missing, we fall
   * back to the newest still-open/locked market for the same team.
   */
  private resolveFromEvent(ev: FeedEvent, outcome: 'YES' | 'NO'): void {
    const target = this.findMarketFor(ev);

    if (target) {
      // Capture the on-chain seed BEFORE cleanupTracked deletes the entry.
      const seed = target.marketSeed;
      this.engine.resolve(target.marketId, outcome); // emits 'resolve' -> broadcast
      this.cleanupTracked(target.marketId);
      // Mirror the resolution on-chain. outcome is 'YES'|'NO' here (never VOID —
      // resolve_market rejects VOID), so it's always a valid program call.
      if (seed !== undefined) void this.chain.resolveMarket(seed, outcome);
    }

    // Update the scoreline on a goal regardless of whether a market existed.
    if (ev.type === 'goal' && ev.team) {
      this.feed.applyGoal(ev.team);
      this.server.broadcast({ t: 'game', game: this.feed.state() });
    }
  }

  /** Find the tracked market this resolution event decides, if any. */
  private findMarketFor(ev: FeedEvent): TrackedMarket | undefined {
    const seq = seqIdOf(ev);

    // 1) Exact correlation by sequenceId.
    if (seq) {
      for (const t of this.tracked.values()) {
        if (t.sequenceId && t.sequenceId === seq) return t;
      }
    }

    // 2) Fallback: newest still-settle-able market whose team POSITIVELY matches
    //    the resolver. We require a confident team match on BOTH sides — a goal we
    //    can't attribute (no team), or a market with no team, is NOT resolved by
    //    this event. This prevents a teamless/other-team goal from settling the
    //    wrong market YES (it instead settles NO on expiry, the honest "that
    //    team's chance didn't score in its window").
    if (!ev.team) return undefined;
    let best: TrackedMarket | undefined;
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if (!t.team || t.team !== ev.team) continue; // require a positive team match
      best = t; // Map preserves insertion order; last match = newest
    }
    return best;
  }

  /**
   * Settle a market whose betting window closed but no goal/miss arrived.
   *
   * Every market we open is a "will this be a GOAL?" question, so a chance that
   * simply passes without a goal resolves NO — that's the real outcome, not a
   * refund. (A genuine feed fault would VOID, but for a goal-question the honest
   * settlement of "no goal happened in the window" is NO.)
   */
  private settleUnresolved(marketId: string): void {
    // Capture the on-chain seed BEFORE cleanupTracked deletes the tracked entry.
    const seed = this.tracked.get(marketId)?.marketSeed;
    const m = this.engine.get(marketId);
    let onChainOutcome: 'NO' | undefined;
    if (m && (m.status === 'open' || m.status === 'locked')) {
      const isGoalQuestion =
        m.kind === 'penalty_scored' || m.kind.startsWith('goal_from');
      const outcome = isGoalQuestion ? 'NO' : 'VOID';
      this.engine.resolve(marketId, outcome);
      // Only mirror real outcomes on-chain — the program rejects VOID via
      // resolve_market, so a VOID stays off-chain only.
      if (outcome === 'NO') onChainOutcome = 'NO';
    }
    this.cleanupTracked(marketId);
    if (seed !== undefined && onChainOutcome) void this.chain.resolveMarket(seed, onChainOutcome);
  }

  private cleanupTracked(marketId: string): void {
    const t = this.tracked.get(marketId);
    if (!t) return;
    t.bots.cancel();
    clearTimeout(t.lockTimer);
    if (t.voidTimer) clearTimeout(t.voidTimer);
    // Any bet still HELD when the market goes away (resolved/voided) is a snipe
    // candidate — the result landed inside its delay. Void + refund it.
    for (const held of t.pending.values()) {
      clearTimeout(held.timer);
      this.rejectHeldBet(marketId, held, 'play resolved before your bet cleared');
    }
    t.pending.clear();
    this.tracked.delete(marketId);
  }

  // -------------------------------------------------------------------------
  // Engine + user wiring
  // -------------------------------------------------------------------------

  /**
   * Turn every engine lifecycle event into the matching broadcast.
   *
   * FRIENDS MODE: in the SAME place, we relay each global market event into the
   * RoomManager, which mirrors AI markets into every active room and resolves
   * them in lockstep. The manager fans the resulting room_* messages out to
   * each room itself (via the broadcastRoom sink the server injected), so there
   * is nothing more to broadcast here.
   */
  private wireEngineBroadcasts(): void {
    const rooms = this.server.roomManager;
    this.engine.on('open', (m: Market) => {
      this.server.broadcast({ t: 'market_open', market: m });
      rooms.onGlobalMarketOpen(m);
    });
    this.engine.on('update', (m: Market) => this.server.broadcast({ t: 'market_update', market: m }));
    this.engine.on('lock', (m: Market) => {
      this.server.broadcast({ t: 'market_lock', market: m });
      rooms.onGlobalMarketLock(m.id);
    });
    // resolve carries the full Settlement (per-user payouts) so the app can credit users.
    this.engine.on('resolve', (m: Market) => {
      // Collect the rake as a trade fee for the treasury. This is how the house
      // makes money — taken off every settled (non-void) market, win or lose.
      if (m.settlement && m.settlement.outcome !== 'VOID') {
        this.feesCollected += m.settlement.rakeTaken;
        this.marketsSettled += 1;
        console.log(
          `[golazo/feed] fee +${m.settlement.rakeTaken.toFixed(2)} → ${this.config.feeRecipient} ` +
            `(total ${this.feesCollected.toFixed(2)} over ${this.marketsSettled} markets)`,
        );
      }
      this.server.broadcast({ t: 'market_resolve', market: m });
      // Mirror the settled outcome into every room (credits room points in lockstep).
      rooms.onGlobalMarketResolve(m);
    });
  }

  /**
   * A user tapped BET. We do NOT place it immediately — we HOLD it for the
   * bet-delay. When the delay elapses we place it (if the market's still open);
   * if the play resolved during the hold
   * (or the market closed), we reject + refund it. This is the anti-latency-
   * arbitrage defense: betting "after seeing the goal on a faster feed" gets
   * caught because the result lands inside the hold window.
   */
  private handleUserBet(msg: Extract<ClientMessage, { t: 'bet' }>): void {
    const t = this.tracked.get(msg.marketId);
    const m = this.engine.get(msg.marketId);
    if (!t || !m || m.status !== 'open') {
      this.rejectHeldBet(msg.marketId, { ...msg }, 'market not open');
      return;
    }
    if (t.pending.has(msg.userId)) return; // one held bet per user at a time

    const held: HeldBet = {
      userId: msg.userId,
      side: msg.side,
      stake: msg.stake,
      timer: setTimeout(() => this.acceptHeldBet(msg.marketId, msg.userId), this.config.betDelayMs),
    };
    t.pending.set(msg.userId, held);
  }

  /** Bet-delay elapsed: place the held bet IF the market is still open, else reject. */
  private acceptHeldBet(marketId: string, userId: string): void {
    const t = this.tracked.get(marketId);
    const held = t?.pending.get(userId);
    if (!t || !held) return;
    t.pending.delete(userId);
    const m = this.engine.get(marketId);
    if (m && m.status === 'open') {
      try {
        this.engine.placeBet(marketId, userId, held.side, held.stake);
        return;
      } catch {
        /* fall through to reject */
      }
    }
    this.rejectHeldBet(marketId, held, 'play resolved before your bet cleared');
  }

  /** Tell the client a held bet was not accepted, so it refunds its optimistic debit. */
  private rejectHeldBet(
    marketId: string,
    held: { userId: string; stake: number },
    reason: string,
  ): void {
    this.server.broadcast({
      t: 'bet_rejected',
      marketId,
      userId: held.userId,
      stake: held.stake,
      reason,
    });
  }
}

/** Pull the correlation sequenceId out of an event's meta, if present. */
function seqIdOf(ev: FeedEvent): string | undefined {
  const seq = ev.meta?.['sequenceId'];
  return typeof seq === 'string' ? seq : undefined;
}
