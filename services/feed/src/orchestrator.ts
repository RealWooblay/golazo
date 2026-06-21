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
  requiresTeam,
  type ClientMessage,
  type FeedEvent,
  type GameState,
  type Market,
  type MarketTrigger,
  type Outcome,
  type Team,
} from '@golazo/core';
import type { Config } from './config';
import type { FeedSource } from './feed/index';
import { createFeed } from './feed/index';
import { EmptyFeed } from './feed/empty';
import { EspnFeed } from './feed/espn';
import { aiTriggerFromEvents } from './ai/watcher';
import {
  buildPeriodMarketTrigger,
  clockMinutes,
  goalAlreadyHappenedForChance,
  isDefensiveSetPiece,
  isStalePlay,
  KEY_EVENT_ONLY_OPENERS,
  bettingClosesAt,
  isGoalMomentKind,
  MOMENTUM_OPEN_THRESHOLD,
  openerPriority,
  knobFor,
  MAX_CONCURRENT_MARKETS,
  PERIOD_MARKET,
  periodMarketKey,
  resolveDeadlineMs,
} from './ai/marketTuning';
import {
  isGoalQuestionKind,
  isPlayMarketKind,
  parseGoalSource,
  transitionPlayPhase,
  type PlayPhaseState,
} from './ai/playPhase';
import {
  MomentumTracker,
  momentumMarketSpec,
  type MomentumRead,
} from './ai/momentum';
import { AuditLog } from './observability/auditLog';
import { FeedMetrics } from './observability/metrics';
import { LagMeter } from './observability/lagMeter';
import { ROOM_RAKE } from '@golazo/core';
import { BotSwarm, resolveBotConfig } from './bots';
import { createChainOperator, type FeedChainOperator } from './chain';
import { FeedServer } from './server';
import { momentKey, parseClockKey } from './feed/espn';

/** Betting window for a momentum-opened market (short — the play is live). */
const MOMENTUM_BET_WINDOW_MS = 10_000;
/**
 * Min gap between momentum-opened markets for the SAME team. Tuned DOWN for volume
 * (momentum time-boxed markets are now the main opener path) — this just stops ONE
 * spell printing the same line back-to-back.
 */
const MOMENTUM_OPEN_COOLDOWN_MS = 25_000;
/**
 * A locked moment market blocks new opens until its resolveAt (the deadline sweep
 * settles it). Past that, the sweep has settled it, so it no longer blocks.
 */
const LOCKED_BLOCK_MS = 75_000;

/** Per-market bookkeeping the orchestrator keeps alongside the engine's Market. */
interface TrackedMarket {
  marketId: string;
  /** sequenceId of the attack event that opened it, for resolution correlation. */
  sequenceId: string | undefined;
  /** team the attack belongs to, so we know whose score to bump on a goal. */
  team: Team | undefined;
  bots: BotSwarm;
  lockTimer: ReturnType<typeof setTimeout>;
  /** Per-type window (ms) after lock — the deadline the per-tick sweep settles on. */
  resolveWindowMs: number;
  /** User bets being HELD for the bet-delay, keyed by userId (one in flight per user). */
  pending: Map<string, HeldBet>;
  /**
   * u64 seed of this market's on-chain twin (when CHAIN MODE created one). Used to
   * drive lock/resolve on-chain. Undefined when chain is off or init failed.
   */
  marketSeed?: number;
  /** Long-lived period market (e.g. extra-time comeback) — different resolve rules. */
  isPeriod?: boolean;
  /** Match-clock (fractional min) when the chance opened — for the late-goal rescue. */
  openClockMin?: number;
  /** Feed event type that opened this market (free_kick, corner, …). */
  openerType?: FeedEvent['type'];
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
  /** Play-mode bets held for the bet-delay (separate pool from real-money). */
  private readonly pointsHeld = new Map<string, Map<string, HeldBet>>();
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
  /** Belt-and-braces dedupe across commentary/keyEvent edge cases + feed restarts. */
  private readonly openedMoments = new Set<string>();
  /** Latest goal/miss clock per team — drives the deadline late-goal rescue. */
  private readonly lastResolverByTeam = new Map<Team, number>();
  /** True once we've seen the clock enter extra time this match. */
  private extraTimeEntered = false;
  /** Period market wanted but blocked by an active moment market — retry when clear. */
  private periodMarketPending = false;
  /** Throttle ESPN re-probes when waiting for a live game (empty/sim fallback). */
  private feedProbeAt = 0;
  private readonly audit = new AuditLog();
  readonly metrics = new FeedMetrics();
  private readonly lagMeter = new LagMeter();
  private playPhase: PlayPhaseState = 'calm';
  /** The agent's live read of who's pressing — drives the bar AND momentum markets. */
  private readonly momentum = new MomentumTracker();
  /** Wall-clock of the last momentum-opened market per team (cooldown). */
  private readonly lastMomentumOpenAt = new Map<Team, number>();
  /** Rotates momentum-market phrasing so a long spell doesn't repeat one line. */
  private momentumCounter = 0;
  /** Sim/test only: every momentum bar value broadcast this run (for assertions). */
  private readonly momentumLog: Array<{ bar: Team | null }> = [];

  constructor(
    private readonly config: Config,
    private feed: FeedSource,
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
      onPointsBet: (msg) => this.handlePointsBet(msg),
      getFees: () => ({
        recipient: this.config.feeRecipient,
        rakeBps: Math.round(this.config.rake * 10000),
        collected: this.feesCollected,
        marketsSettled: this.marketsSettled,
      }),
      getOps: () => ({
        feedKind: this.feed.kind,
        watcher: this.config.anthropicApiKey ? 'ai' : 'rules',
        metrics: this.metrics.snapshot(
          this.server.clientCount(),
          this.server.roomManager.roomCount(),
        ),
        audit: this.audit.recent(30),
        playPhase: this.playPhase,
      }),
      getOpenGlobalMarket: () =>
        this.engine.list().find((m) => m.status === 'open' || m.status === 'locked'),
      betDelayMs: this.config.betDelayMs,
    });

    this.wireEngineBroadcasts();
  }

  /** Bind the server, push an initial game frame, and start the feed loop. */
  async start(): Promise<void> {
    await this.server.listen();

    this.server.roomManager.configureChain(
      this.chain.active && this.chainAuthority
        ? {
            active: true,
            authority: this.chainAuthority,
            nextSeed: () => this.nextMarketSeed(),
            rakeBps: Math.round(this.config.rake * 10000),
            seedLamports: this.config.chainSeedLamports,
            initMarket: (args) =>
              this.chain.initMarket({
                marketSeed: args.marketSeed,
                questionText: args.questionText,
                rakeBps: Math.round(ROOM_RAKE * 10000),
                seedYesLamports: this.config.chainSeedLamports,
                seedNoLamports: this.config.chainSeedLamports,
              }),
            lockMarket: (seed) => void this.chain.lockMarket(seed),
            resolveMarket: (seed, outcome) => void this.chain.settleMarket(seed, outcome),
          }
        : null,
    );

    this.server.broadcast({ t: 'game', game: this.feed.state() });

    // One driving tick: poll the feed, process events. We reuse the ESPN poll
    // interval for the cadence; the sim is cheap so over-polling is harmless.
    const intervalMs = this.feed.kind === 'espn' ? this.config.espnPollMs : 500;
    this.tickTimer = setInterval(() => void this.tick(), intervalMs);
  }

  /**
   * Sim/test hook: run ONE feed→market tick on demand (production drives ticks
   * via the interval in start()). Lets a headless simulation replay a whole match
   * deterministically under fake timers without binding the WS server.
   */
  async simTick(): Promise<void> {
    await this.tick();
  }

  /** Sim/test hook: every market the engine has seen this run (open/locked/settled). */
  simMarkets(): Market[] {
    return this.engine.list();
  }

  /** Sim/test hook: every momentum bar value broadcast this run (proves the bar fires + moves). */
  simMomentum(): ReadonlyArray<{ bar: Team | null }> {
    return this.momentumLog;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.tracked.values()) {
      t.bots.cancel();
      clearTimeout(t.lockTimer);
    }
    this.tracked.clear();
    await this.feed.close();
    await this.server.close();
  }

  // -------------------------------------------------------------------------
  // Feed processing
  // -------------------------------------------------------------------------

  /** One iteration: poll feed, refresh game frame, check period markets, process events. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.maybeSwitchFeed();
    const t0 = Date.now();
    let events: FeedEvent[];
    try {
      events = await this.feed.poll(Date.now());
    } catch {
      this.metrics.recordPoll(Date.now() - t0, 0, true);
      return;
    }

    const game = this.feed.state();
    this.server.broadcast({ t: 'game', game });
    this.server.roomManager.lockExpiredMarkets();
    await this.checkPeriodMarkets(game);

    const ordered = sortFeedEvents(events);

    this.metrics.recordPoll(Date.now() - t0, ordered.length);
    this.audit.record('feed_poll', { events: ordered.length, ms: Date.now() - t0 });

    for (const ev of ordered) {
      await this.processEvent(ev);
    }

    // THE ONE NO-WRITER: a single per-tick deadline sweep. Any locked market past
    // its resolveAt with no qualifying YES settles NO (after the late-goal rescue).
    this.settleExpired(Date.now());
  }

  private async processEvent(ev: FeedEvent): Promise<void> {
    this.server.broadcast({ t: 'commentary', text: ev.text, ts: ev.ts });

    this.lagMeter.observe(ev, this.feed.state());
    this.metrics.recordLag(this.lagMeter.clockLagMin());
    this.metrics.wallclockLagSec = this.lagMeter.wallclockLagSec();
    this.playPhase = transitionPlayPhase(this.playPhase, ev);
    this.metrics.playPhase = this.playPhase;

    this.recent.push(ev);
    if (this.recent.length > 30) this.recent.shift();

    // The agent reads momentum off every event, then pushes it to the bar.
    this.momentum.observe(ev);
    this.broadcastMomentum();

    // Momentum time-boxed markets — the volume driver. Driven off the momentum
    // READ on ANY weighted event (not just shot/miss), opened for the leader when
    // the read clears threshold. Pure wall-clock windows → reliable under feed lag.
    await this.maybeOpenMomentumMarket(this.momentum.read());

    // RESOLVER branch — an event can only ever cause YES (NO comes from the
    // per-tick deadline sweep). Resolver-ish events route here and never reach the
    // opener path below. `shot`/`miss` are YES signals for play/window markets.
    if (
      outcomeFromEvent(ev) !== null ||
      this.isResolverEvent(ev) ||
      ev.type === 'shot' ||
      ev.type === 'miss'
    ) {
      await this.resolveFromEvent(ev);
      return;
    }

    if (ev.type === 'final') {
      this.resolveOpenPeriodMarkets('NO');
      return;
    }

    // Otherwise this might be a bettable "set moment". The watcher decides (rules
    // for set-pieces) — and returns null for calm/non-bettable events.
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

  /** Rules opener (set-pieces only now): if it yields a trigger, open the market. */
  private async maybeOpenMarket(ev: FeedEvent): Promise<void> {
    // One market on the table at a time — except a LOCKED period market (ET comeback)
    // doesn't block new moment markets; only an open betting window does.
    if (this.hasBlockingMarket(false, ev)) return;

    const game = this.feed.state();

    // After a feed restart ESPN replays the full backlog — never open a market
    // for a moment that's already several minutes in the past.
    if (isStalePlay(ev, game)) {
      this.metrics.marketsSkipped++;
      this.audit.record('market_skip', { reason: 'stale_clock', type: ev.type });
      return;
    }

    if (this.lagMeter.isWallclockStale()) {
      this.metrics.marketsSkipped++;
      this.audit.record('market_skip', {
        reason: 'stale_wallclock',
        lagSec: this.lagMeter.wallclockLagSec() ?? 0,
        type: ev.type,
      });
      return;
    }

    if (KEY_EVENT_ONLY_OPENERS.has(ev.type) && ev.meta?.source !== 'espn.keyEvent') {
      return;
    }

    const mk = momentKey(ev);
    if (mk && this.openedMoments.has(mk)) return;

    const trigger = await aiTriggerFromEvents([...this.recent], game, {
      homeName: game.home.name,
      awayName: game.away.name,
    });
    if (!trigger) return;

    // Final safety: never open a team-bound market without a team (no "They …").
    if (!trigger.team && requiresTeam(trigger.kind)) return;

    if (mk) this.openedMoments.add(mk);

    this.audit.record('watcher_rules', { type: ev.type, text: ev.text.slice(0, 80) });

    await this.openTriggeredMarket(trigger, {
      sequenceId: seqIdOf(ev),
      team: ev.team,
      openClockMin: clockMinutes(ev),
      openerType: ev.type,
      logLabel: `type=${ev.type} team=${ev.team ?? 'n/a'} clock=${String(ev.meta?.clock ?? game.clock)}`,
    });
  }

  /** Push the agent's momentum read to clients (drives the session momentum bar). */
  private broadcastMomentum(): void {
    const r = this.momentum.read();
    this.momentumLog.push({ bar: r.bar });
    this.server.broadcast({ t: 'momentum', bar: r.bar, home: r.home, away: r.away });
  }

  /** True when the pressing team already has a live (open/locked) momentum market. */
  private hasOpenMomentumMarketFor(team: Team): boolean {
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if (t.team === team && (m.kind === 'shot_in_window' || m.kind === 'score_in_window')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Momentum-DRIVEN time-boxed market — the volume engine. Driven off the momentum
   * READ on ANY weighted event: when a side leads the press past threshold, open a
   * wall-clock window market ("a shot this spell?" / "to score in N minutes?"). The
   * window is pure wall-clock, so it resolves deterministically under feed lag —
   * a real shot/goal before resolveAt = YES, else the deadline sweep settles NO.
   */
  private async maybeOpenMomentumMarket(read: MomentumRead): Promise<void> {
    const team = read.leader;
    if (!team) return;
    if (read.intensity < MOMENTUM_OPEN_THRESHOLD) return;

    const last = this.lastMomentumOpenAt.get(team) ?? 0;
    if (Date.now() - last < MOMENTUM_OPEN_COOLDOWN_MS) return;
    if (this.hasOpenMomentumMarketFor(team)) return;
    if (this.hasBlockingMarket(false)) return;

    const game = this.feed.state();
    const name = team === 'home' ? game.home.name : game.away.name;
    if (!name) return;

    const spec = momentumMarketSpec(name, read.intensity, this.momentumCounter++);
    const trigger: MarketTrigger = {
      gameId: game.gameId,
      question: spec.question,
      kind: spec.kind,
      team,
      windowMs: MOMENTUM_BET_WINDOW_MS,
      trueProb: spec.trueProb,
    };

    this.lastMomentumOpenAt.set(team, Date.now());
    await this.openTriggeredMarket(trigger, {
      team,
      logLabel: `momentum kind=${spec.kind} team=${team} intensity=${read.intensity.toFixed(1)}`,
    });
  }

  /**
   * Extra-time period markets — state-triggered, not tied to a single play.
   * Opens on ET entry (or retries once a blocking moment market clears).
   */
  private async checkPeriodMarkets(game: GameState): Promise<void> {
    if (game.status === 'final') {
      this.resolveOpenPeriodMarkets('NO');
      return;
    }

    const pk = periodMarketKey(game.gameId);
    if (this.openedMoments.has(pk)) return;
    for (const m of this.engine.list()) {
      if (m.kind === 'goal_in_extra_time') {
        this.openedMoments.add(pk);
        return;
      }
    }

    const trigger = buildPeriodMarketTrigger(game);
    if (!trigger) {
      this.periodMarketPending = false;
      return;
    }

    const inEt = parseClockKey(game.clock).base > 90;
    const justEnteredEt = inEt && !this.extraTimeEntered;
    if (inEt) this.extraTimeEntered = true;

    if (!justEnteredEt && !this.periodMarketPending) return;

    if (this.hasBlockingMarket(true)) {
      this.periodMarketPending = true;
      return;
    }

    this.periodMarketPending = false;
    this.openedMoments.add(pk);

    console.log(`[golazo/feed] period_market_open clock=${game.clock} q="${trigger.question}"`);

    await this.openTriggeredMarket(trigger, {
      team: trigger.team,
      isPeriod: true,
      logLabel: `period clock=${game.clock}`,
    });
  }

  /**
   * Is another market blocking a new open?
   * @param forPeriod — period markets only yield to an OPEN moment market, not a locked one.
   */
  private hasBlockingMarket(forPeriod: boolean, incoming?: FeedEvent): boolean {
    const incomingPri = incoming ? openerPriority(incoming.type) : 9;
    let active = 0;
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      // A lingering low-priority VAR/penalty market never blocks a live goal chance.
      if (incoming && incomingPri <= 1 && !isGoalMomentKind(m.kind) && m.kind === 'penalty_awarded') {
        continue;
      }
      if (forPeriod) {
        // A period market (ET comeback) only needs a clear OPEN betting slot — a
        // locked market settling out is fine.
        if (m.status === 'open') return true;
        continue;
      }
      if (m.status === 'open') {
        active++;
      } else if (m.status === 'locked' && !t.isPeriod) {
        // A locked market blocks until its deadline sweep settles it. Past resolveAt
        // it's effectively settled (the next tick's settleExpired will finalize it),
        // so it no longer blocks a new open.
        if (Date.now() < m.resolveAt && Date.now() - m.lockAt < LOCKED_BLOCK_MS) active++;
      }
    }
    if (forPeriod) return false;
    // Serial feed — only one open (or freshly locked) market at a time.
    return active >= MAX_CONCURRENT_MARKETS;
  }

  /** Open a market from a validated trigger — shared by moment + period paths. */
  private async openTriggeredMarket(
    trigger: MarketTrigger,
    opts: {
      sequenceId?: string;
      team?: Team;
      isPeriod?: boolean;
      openClockMin?: number;
      openerType?: FeedEvent['type'];
      logLabel: string;
    },
  ): Promise<void> {
    if (!opts.isPeriod && this.hasBlockingMarket(false)) return;

    const deadline = resolveDeadlineMs(trigger.kind);
    const armed: MarketTrigger = { ...trigger, resolveWindowMs: deadline };

    console.log(
      `[golazo/feed] market_open ${opts.logLabel} resolve=${Math.round(deadline / 1000)}s ` +
        `q="${armed.question.slice(0, 60)}"`,
    );

    let marketSeed: number | undefined;
    if (this.chain.active && this.chainAuthority) {
      marketSeed = this.nextMarketSeed();
      const seed = marketSeed;
      const initRes = await this.chain.initMarket({
        marketSeed: seed,
        questionText: trigger.question,
        rakeBps: Math.round(this.config.rake * 10000),
        seedYesLamports: this.config.chainSeedLamports,
        seedNoLamports: this.config.chainSeedLamports,
      });
      if (initRes) {
        trigger.onChain = { marketSeed: seed, authority: this.chainAuthority };
        console.log(
          `[golazo/feed] chain initMarket seed=${seed} ` +
            `market=${initRes.marketPda.toBase58()} sig=${initRes.signature}`,
        );
      } else {
        console.warn(`[golazo/feed] chain initMarket seed=${seed} failed — play-money only`);
        marketSeed = undefined;
      }
    }

    const market = this.engine.openMarket(armed);
    this.metrics.marketsOpened++;
    this.audit.record('market_open', { question: armed.question, kind: armed.kind }, market.id);

    const bots = new BotSwarm(this.engine, resolveBotConfig({ count: this.config.botCount }));
    bots.start(market);

    const lockTimer = setTimeout(() => this.lockMarket(market.id), armed.windowMs);

    this.tracked.set(market.id, {
      marketId: market.id,
      sequenceId: opts.sequenceId,
      team: opts.team,
      bots,
      lockTimer,
      resolveWindowMs: deadline,
      pending: new Map(),
      marketSeed,
      ...(opts.openClockMin !== undefined ? { openClockMin: opts.openClockMin } : {}),
      ...(opts.openerType ? { openerType: opts.openerType } : {}),
      ...(opts.isPeriod ? { isPeriod: true } : {}),
    });
  }

  /** Settle all open/locked period markets (e.g. full time with no comeback goal). */
  private resolveOpenPeriodMarkets(outcome: 'NO'): void {
    for (const t of [...this.tracked.values()]) {
      if (!t.isPeriod) continue;
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      const seed = t.marketSeed;
      this.engine.resolve(t.marketId, outcome);
      this.cleanupTracked(t.marketId);
      if (seed !== undefined) void this.chain.settleMarket(seed, outcome);
    }
    this.periodMarketPending = false;
  }

  /** Lock a market: stop bots, lock the engine. The deadline sweep handles NO. */
  private lockMarket(marketId: string): void {
    const t = this.tracked.get(marketId);
    if (!t) return;
    t.bots.cancel();
    const m = this.engine.get(marketId);
    if (m && m.status === 'open') this.engine.lock(marketId);

    // Mirror the lock on-chain (best-effort, fire-and-forget — never blocks).
    if (t.marketSeed !== undefined) void this.chain.lockMarket(t.marketSeed);
  }

  /**
   * THE ONE NO-WRITER. Per-tick deadline sweep: every locked market past its
   * wall-clock `resolveAt` with no qualifying YES settles NO — after consulting the
   * late-goal rescue (`goalAlreadyHappenedForChance`) so a goal that landed in a
   * later poll on the ~2-min feed still settles YES. NO is written here and NOWHERE
   * else; an event can only ever cause YES. This is what kills the "resolved NO
   * instead of void" bug AND the "random void" bug by construction.
   */
  private settleExpired(now: number): void {
    for (const t of [...this.tracked.values()]) {
      if (t.isPeriod) continue; // period markets settle on their own goal / FT
      const m = this.engine.get(t.marketId);
      if (!m || m.status !== 'locked') continue;
      if (now < m.resolveAt) continue;

      // Late-goal rescue: for kinds where ANY goal by the team in-window counts
      // (momentum / open-play / extra-time), if a goal was recorded at/after the
      // market opened, settle YES instead of NO. Strict set-piece kinds require
      // attributed evidence (handled at the goal event), so they always NO here.
      if (
        anyTeamGoalCountsYes(m.kind) &&
        goalAlreadyHappenedForChance(t.team, t.openClockMin, this.lastResolverByTeam)
      ) {
        console.log(
          `[golazo/feed] market_deadline_late_goal id=${m.id} kind=${m.kind} team=${t.team ?? 'n/a'}`,
        );
        this.finalizeMarket(t, 'YES');
        continue;
      }

      console.log(`[golazo/feed] market_deadline_no id=${m.id} kind=${m.kind}`);
      this.finalizeMarket(t, 'NO');
    }
  }

  /**
   * Resolve a market from a feed event. THE ONE RULE: an event can only ever cause
   * YES. We find the market, and if the event qualifies it YES (goal attribution via
   * `parseGoalSource` for goal kinds), finalize YES. Otherwise we just record the
   * resolver clock and return — NO is the deadline sweep's job, never an event's.
   */
  private async resolveFromEvent(ev: FeedEvent): Promise<void> {
    this.recordResolverClock(ev);

    const target = this.findMarketFor(ev);
    if (!target) {
      if (ev.type === 'goal' && ev.team) {
        this.feed.applyGoal(ev.team);
        this.server.broadcast({ t: 'game', game: this.feed.state() });
      }
      return;
    }

    const m = this.engine.get(target.marketId);
    if (!m) return;

    // NOTE: we no longer VOID when an outcome lands while betting is still open. On a
    // ~2-min feed that "early" condition fires constantly and refunds whole pools; the
    // bet-delay HOLD (handleUserBet/acceptHeldBet) is the real latency-arb defense — a
    // user bet placed after the result lands inside its hold gets rejected + refunded.
    // The market itself simply settles YES on the qualifying event.

    if (target.isPeriod && ev.type === 'goal' && target.team && ev.team !== target.team) {
      return;
    }
    if (m.kind === 'penalty_awarded' && ev.type === 'goal') return;

    // Goal attribution for strict goal-question kinds: ESPN's own goal text decides.
    // 'yes' → YES; 'no'/'ambiguous' → not this moment, let the deadline settle NO.
    if (ev.type === 'goal' && isGoalQuestionKind(m.kind)) {
      if (parseGoalSource(ev.text, m.kind) === 'yes') {
        this.finalizeMarket(target, 'YES', ev);
      }
      return;
    }

    // Everything else: an event only ever causes YES (else the deadline sweep NOs it).
    if (outcomeFromEvent(ev, m.kind) === 'YES') {
      this.finalizeMarket(target, 'YES', ev);
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
    //    the resolver. Period markets only settle on goals (handled below) or FT.
    if (ev.type === 'miss') {
      for (const t of this.tracked.values()) {
        if (t.isPeriod) continue;
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        if (!isWindowOrPlayKind(m.kind)) continue;
        if (!t.team || t.team !== ev.team) continue;
        return t;
      }
      return undefined;
    }

    if (ev.type === 'var_penalty_denied') {
      for (const t of this.tracked.values()) {
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        if (m.kind === 'penalty_awarded') return t;
      }
      return undefined;
    }

    if (ev.type === 'penalty') {
      for (const t of this.tracked.values()) {
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        if (m.kind === 'penalty_awarded') return t;
      }
    }

    // A red card (incl. second yellow) settles an open VAR "RED card?" review — the
    // market is teamless ("will this review produce a red?"), so any red card counts.
    if (ev.type === 'red_card') {
      for (const t of this.tracked.values()) {
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        if (m.kind === 'red_card_given') return t;
      }
    }

    if (!ev.team) {
      let best: TrackedMarket | undefined;
      for (const t of this.tracked.values()) {
        if (t.isPeriod) continue;
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        if (!isWindowOrPlayKind(m.kind)) continue;
        best = t;
      }
      return best;
    }
    let bestMoment: TrackedMarket | undefined;
    let bestPeriod: TrackedMarket | undefined;
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if (t.isPeriod && !t.team && ev.type === 'goal') {
        bestPeriod = t;
        continue;
      }
      if (!t.team || t.team !== ev.team) continue;
      if (t.isPeriod) bestPeriod = t;
      else if (isWindowOrPlayKind(m.kind)) bestMoment = t;
    }
    return bestMoment ?? bestPeriod;
  }

  /** Apply a final outcome and mirror on-chain. */
  private finalizeMarket(target: TrackedMarket, outcome: Outcome, ev?: FeedEvent): void {
    const seed = target.marketSeed;
    this.engine.resolve(target.marketId, outcome);
    this.metrics.marketsResolved++;
    this.audit.record('market_resolve', { outcome }, target.marketId);
    this.cleanupTracked(target.marketId);
    if (seed !== undefined) void this.chain.settleMarket(seed, outcome);

    if (ev?.type === 'goal' && ev.team) {
      this.feed.applyGoal(ev.team);
      this.server.broadcast({ t: 'game', game: this.feed.state() });
    }

    if (!target.isPeriod) this.periodMarketPending = this.periodMarketPending || this.extraTimeEntered;
  }

  /** Events that can settle a market (beyond goal/miss). */
  private isResolverEvent(ev: FeedEvent): boolean {
    return (
      ev.type === 'yellow_card' ||
      ev.type === 'red_card' ||
      ev.type === 'var_penalty_denied' ||
      ev.type === 'penalty'
    );
  }

  /** VOID + refund — optional commentary so the UI explains why. */
  private voidMarket(target: TrackedMarket, commentary?: string): void {
    const seed = target.marketSeed;
    this.engine.resolve(target.marketId, 'VOID');
    this.metrics.marketsVoided++;
    this.audit.record('market_void', { reason: commentary?.slice(0, 80) ?? 'fairness' }, target.marketId);
    this.cleanupTracked(target.marketId);
    if (seed !== undefined) void this.chain.settleMarket(seed, 'VOID');
    if (commentary) this.server.broadcast({ t: 'commentary', text: commentary, ts: Date.now() });
  }

  /**
   * Keep the feed on the right match:
   *   • ESPN + match ended → rotate to the next live fixture, or go empty and probe
   *   • empty/sim → promote when a live game appears (never demo sim in production)
   */
  private async maybeSwitchFeed(): Promise<void> {
    if (this.config.feedMode === 'sim' || this.config.feedMode === 'replay') return;

    // ── Active ESPN feed: rotate when this match is over ─────────────────────
    if (this.feed.kind === 'espn') {
      const espn = this.feed as EspnFeed;
      if (!espn.shouldRotate()) return;

      const prev = espn.state();
      if (await espn.rotateToNextLive()) {
        this.resetForNewMatch();
        const g = this.feed.state();
        console.log(
          `[golazo/feed] rotated live: ${prev.home.name} vs ${prev.away.name} (final) → ` +
            `${g.home.name} vs ${g.away.name}`,
        );
        this.server.broadcast({ t: 'game', game: g });
        return;
      }

      await this.feed.close().catch(() => {});
      this.feed = new EmptyFeed();
      this.resetForNewMatch();
      this.server.broadcast({ t: 'game', game: this.feed.state() });
      console.log(
        `[golazo/feed] match ended (${prev.home.name} vs ${prev.away.name}) — waiting for next live game`,
      );
      this.feedProbeAt = 0;
      return;
    }

    // ── Empty/sim: probe for a live ESPN game ───────────────────────────────
    const now = Date.now();
    if (now < this.feedProbeAt) return;
    this.feedProbeAt = now + 15_000;

    const { feed, reason } = await createFeed({ ...this.config, feedMode: 'espn' });
    if (feed.kind !== 'espn') {
      await feed.close().catch(() => {});
      return;
    }

    await this.feed.close().catch(() => {});
    this.feed = feed;
    this.resetForNewMatch();
    const g = feed.state();
    console.log(`[golazo/feed] promoted to live ESPN (${reason}): ${g.home.name} vs ${g.away.name}`);
    this.server.broadcast({ t: 'game', game: g });
  }

  /** Clear per-match orchestrator state when the feed switches fixtures. */
  private resetForNewMatch(): void {
    this.openedMoments.clear();
    this.lastResolverByTeam.clear();
    this.lastMomentumOpenAt.clear();
    this.extraTimeEntered = false;
    this.periodMarketPending = false;
    this.recent.length = 0;
    for (const t of [...this.tracked.values()]) {
      this.voidMarket(t);
    }
  }

  private cleanupTracked(marketId: string): void {
    const t = this.tracked.get(marketId);
    if (!t) return;
    t.bots.cancel();
    clearTimeout(t.lockTimer);
    // Any bet still HELD when the market goes away (resolved/voided) is a snipe
    // candidate — the result landed inside its delay. Void + refund it.
    for (const held of t.pending.values()) {
      clearTimeout(held.timer);
      this.rejectHeldBet(marketId, held, 'play resolved before your bet cleared');
    }
    t.pending.clear();
    this.tracked.delete(marketId);
    if (!t.isPeriod && this.extraTimeEntered) this.periodMarketPending = true;
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
      this.server.pointsManager.onMarketOpen(m);
      rooms.onGlobalMarketOpen(m);
    });
    this.engine.on('update', (m: Market) => this.server.broadcast({ t: 'market_update', market: m }));
    this.engine.on('lock', (m: Market) => {
      this.server.broadcast({ t: 'market_lock', market: m });
      this.server.pointsManager.onMarketLock(m.id);
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
      // Paper pool settles its own bets; real bets ALSO move the bettor's
      // cross-mode points score by their net result — both feed one leaderboard.
      this.server.emitPoints(this.server.pointsManager.onMarketResolve(m));
      this.server.emitPoints(this.server.pointsManager.awardRealBet(m));
      this.pointsHeld.delete(m.id);
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
    const cutoff = bettingClosesAt(m.lockAt, m.windowMs);
    if (Date.now() >= cutoff) {
      this.rejectHeldBet(msg.marketId, { ...msg }, 'betting window closing');
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
    const now = Date.now();
    if (m && m.status === 'open' && now < bettingClosesAt(m.lockAt, m.windowMs)) {
      try {
        this.engine.placeBet(marketId, userId, held.side, held.stake);
        return;
      } catch {
        /* fall through to reject */
      }
    }
    this.rejectHeldBet(
      marketId,
      held,
      m && now >= bettingClosesAt(m.lockAt, m.windowMs)
        ? 'betting window closed'
        : 'play resolved before your bet cleared',
    );
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

  /** Play-mode bet with the same anti-latency hold as real-money bets. */
  private handlePointsBet(msg: Extract<ClientMessage, { t: 'points_bet' }>): void {
    const t = this.tracked.get(msg.marketId);
    const m = this.engine.get(msg.marketId);
    if (!t || !m || m.status !== 'open') {
      this.rejectPointsHeldBet(msg.marketId, { ...msg }, 'market not open');
      return;
    }
    const cutoff = bettingClosesAt(m.lockAt, m.windowMs);
    if (Date.now() >= cutoff) {
      this.rejectPointsHeldBet(msg.marketId, { ...msg }, 'betting window closing');
      return;
    }
    let pending = this.pointsHeld.get(msg.marketId);
    if (!pending) {
      pending = new Map();
      this.pointsHeld.set(msg.marketId, pending);
    }
    if (pending.has(msg.userId)) return;

    const held: HeldBet = {
      userId: msg.userId,
      side: msg.side,
      stake: msg.stake,
      timer: setTimeout(
        () => this.acceptPointsHeldBet(msg.marketId, msg.userId),
        this.config.betDelayMs,
      ),
    };
    pending.set(msg.userId, held);
  }

  private acceptPointsHeldBet(marketId: string, userId: string): void {
    const pending = this.pointsHeld.get(marketId);
    const held = pending?.get(userId);
    if (!pending || !held) return;
    pending.delete(userId);
    const m = this.engine.get(marketId);
    const now = Date.now();
    if (m && m.status === 'open' && now < bettingClosesAt(m.lockAt, m.windowMs)) {
      const effects = this.server.pointsManager.placeBet(
        userId,
        marketId,
        held.side,
        held.stake,
      );
      if (effects.rejected) {
        this.server.emitPoints(effects);
        return;
      }
      this.server.emitPoints(effects);
      return;
    }
    this.rejectPointsHeldBet(
      marketId,
      held,
      m && now >= bettingClosesAt(m.lockAt, m.windowMs)
        ? 'betting window closed'
        : 'play resolved before your bet cleared',
    );
  }

  private rejectPointsHeldBet(
    marketId: string,
    held: { userId: string; stake: number },
    reason: string,
  ): void {
    this.server.emitPoints({
      rejected: { userId: held.userId, marketId, stake: held.stake, reason },
    });
  }

  /** Remember goal/miss clocks so a late corner/penalty dup doesn't open. */
  private recordResolverClock(ev: FeedEvent): void {
    if ((ev.type !== 'goal' && ev.type !== 'miss') || !ev.team) return;
    const min = clockMinutes(ev);
    if (min === undefined) return;
    const prev = this.lastResolverByTeam.get(ev.team);
    if (prev === undefined || min >= prev) this.lastResolverByTeam.set(ev.team, min);
  }

}

/** Process goal-scoring openers before card/VAR lines at the same clock. */
function sortFeedEvents(events: FeedEvent[]): FeedEvent[] {
  const isResolver = (ev: FeedEvent) =>
    ev.type === 'goal' ||
    ev.type === 'miss' ||
    ev.type === 'shot' ||
    ev.type === 'yellow_card' ||
    ev.type === 'red_card' ||
    ev.type === 'var_penalty_denied';

  return [...events].sort((a, b) => {
    const ac = clockMinutes(a) ?? 0;
    const bc = clockMinutes(b) ?? 0;
    if (ac !== bc) return ac - bc;
    const ra = isResolver(a) ? 1 : 0;
    const rb = isResolver(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return openerPriority(a.type) - openerPriority(b.type);
  });
}

/** Pull the correlation sequenceId out of an event's meta, if present. */
function seqIdOf(ev: FeedEvent): string | undefined {
  const seq = ev.meta?.['sequenceId'];
  return typeof seq === 'string' ? seq : undefined;
}

/** Kinds that resolve on a team shot/goal in their wall-clock window or play phase. */
function isWindowOrPlayKind(kind: string): boolean {
  return isPlayMarketKind(kind) || kind === 'shot_in_window' || kind === 'score_in_window';
}

/**
 * True for kinds where ANY goal by the team in-window counts YES (used by the
 * deadline late-goal rescue). Strict set-piece goal kinds need attributed evidence,
 * so they are excluded — they only YES from `parseGoalSource` on the goal event.
 */
function anyTeamGoalCountsYes(kind: string): boolean {
  return (
    kind === 'score_in_window' ||
    kind === 'chance_from_play' ||
    kind === 'goal_from_open_play' ||
    kind === 'goal_in_extra_time'
  );
}
