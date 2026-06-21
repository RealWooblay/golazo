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
  type MarketSlot,
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
  marketSlot,
  MOMENTUM_OPEN_THRESHOLD,
  openerPriority,
  knobFor,
  PERIOD_MARKET,
  periodMarketKeyForGame,
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
const MOMENTUM_OPEN_COOLDOWN_MS = 12_000;
/**
 * After a team SCORES, suppress its momentum "to SCORE in N min?" market for this long.
 * A score market that pops right after a goal reads as an instant open+shut (and the
 * late-goal rescue could even settle it YES off the goal that just happened).
 */
const SCORE_COOLOFF_MS = 25_000;
/** Per-market bookkeeping the orchestrator keeps alongside the engine's Market. */
interface TrackedMarket {
  marketId: string;
  /** sequenceId of the attack event that opened it, for resolution correlation. */
  sequenceId: string | undefined;
  /** team the attack belongs to, so we know whose score to bump on a goal. */
  team: Team | undefined;
  bots: BotSwarm;
  lockTimer: ReturnType<typeof setTimeout>;
  /**
   * Deferred ON-CHAIN lock timer. The engine + UI lock at `windowMs` (via lockTimer),
   * but the chain twin's lock is held back CHAIN_LOCK_GRACE_MS so an in-flight
   * real-money place_bet can still land before the chain market flips to Locked.
   */
  chainLockTimer?: ReturnType<typeof setTimeout>;
  /** True once the on-chain lock has actually been fired (deferred timer or flush). */
  chainLocked?: boolean;
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
  /** Concurrency/UI lane for this market. */
  slot: MarketSlot;
  /** Match-clock (fractional min) when the chance opened — for the late-goal rescue. */
  openClockMin?: number;
  /** Feed event type that opened this market (free_kick, corner, …). */
  openerType?: FeedEvent['type'];
  /**
   * Monotonic event index at open. A market may ONLY be resolved by events strictly
   * after this — the event that opens "a shot this spell?" can never be its own YES.
   */
  openSeq?: number;
  /**
   * An outcome decided while betting was still OPEN. Held here and applied the moment
   * the market locks, so a market can never open and resolve in the same breath —
   * there is always a real window to bet in. A later YES overrides a held miss/NO.
   */
  pendingOutcome?: OutcomeDecision;
}

/** A user bet held for the bet-delay window before it enters the pool. */
interface HeldBet {
  userId: string;
  side: 'YES' | 'NO';
  stake: number;
  timer: ReturnType<typeof setTimeout>;
}

interface OutcomeDecision {
  outcome: Outcome;
  voidCause?: string;
  voidReason?: string;
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
  /** Resolver keys from the current poll batch; opener twins in same batch are skipped. */
  private samePollResolverSeqs = new Set<string>();
  private samePollResolverKeys = new Set<string>();
  /** Teams with an outcome event in the current poll batch (open-side snipe guard). */
  private samePollResolverTeams = new Set<Team>();
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
  /** Wall-clock of each team's last goal — gates the post-goal score-market cool-off. */
  private readonly lastGoalAt = new Map<Team, number>();
  /** Rotates momentum-market phrasing so a long spell doesn't repeat one line. */
  private momentumCounter = 0;
  /**
   * Monotonic counter bumped once per processed feed event. Stamped onto each market
   * at open (openSeq) so resolution can require events strictly AFTER the open — the
   * triggering event can never resolve the market it just opened.
   */
  private eventCounter = 0;
  /** Sim/test only: every momentum bar value broadcast this run (for assertions). */
  private readonly momentumLog: Array<{ bar: Team | null; home: number; away: number }> = [];

  constructor(
    private readonly config: Config,
    private feed: FeedSource,
    // The on-chain operator reads its own config from process.env (CHAIN_ENABLED,
    // OPERATOR_KEYPAIR, SOLANA_RPC_URL, GOLAZO_PROGRAM_ID). Inactive → every call
    // is a no-op returning null, so the hot path never depends on Solana. Injectable
    // so tests can assert the chain-lock timing without a live validator.
    chain: FeedChainOperator = createChainOperator(),
  ) {
    this.engine = new MarketEngine({
      rake: config.rake,
      baseSeed: 0,
      now: () => Date.now(),
    });

    this.chain = chain;
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
      getOpenGlobalMarkets: () =>
        this.engine.list().filter((m) => m.status === 'open' || m.status === 'locked'),
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
  simMomentum(): ReadonlyArray<{ bar: Team | null; home: number; away: number }> {
    return this.momentumLog;
  }

  /** Sim/test hook: the audit trail (so the sim can prove every VOID is a match-switch). */
  simAudit(): ReturnType<AuditLog['recent']> {
    return this.audit.recent(500);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.tracked.values()) {
      t.bots.cancel();
      clearTimeout(t.lockTimer);
      if (t.chainLockTimer) clearTimeout(t.chainLockTimer);
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

    // HEARTBEAT: push a momentum frame every tick (not just on events) so the bar
    // keeps breathing through quiet spells instead of freezing between sparse polls.
    this.broadcastMomentum();

    const ordered = sortFeedEvents(events);
    this.samePollResolverSeqs = new Set(
      ordered
        .filter(isOutcomeEvent)
        .map(seqIdOf)
        .filter((seq): seq is string => !!seq),
    );
    this.samePollResolverKeys = new Set(
      ordered
        .filter(isOutcomeEvent)
        .map(resolverBatchKey)
        .filter((key): key is string => !!key),
    );
    // Teams that already have an outcome (shot/goal/miss/…) in THIS batch — used by
    // the momentum opener so it won't open a market whose result is already in-batch.
    this.samePollResolverTeams = new Set(
      ordered
        .filter(isOutcomeEvent)
        .map((e) => e.team)
        .filter((t): t is Team => !!t),
    );

    this.metrics.recordPoll(Date.now() - t0, ordered.length);
    this.audit.record('feed_poll', { events: ordered.length, ms: Date.now() - t0 });

    try {
      for (const ev of ordered) {
        await this.processEvent(ev);
      }
    } finally {
      this.samePollResolverSeqs.clear();
      this.samePollResolverKeys.clear();
      this.samePollResolverTeams.clear();
    }

    // THE ONE NO-WRITER: a single per-tick deadline sweep. Any locked market past
    // its resolveAt with no qualifying YES settles NO (after the late-goal rescue).
    this.settleExpired(Date.now());
  }

  private async processEvent(ev: FeedEvent): Promise<void> {
    this.eventCounter++;
    this.server.broadcast({ t: 'commentary', text: ev.text, ts: ev.ts });

    this.lagMeter.observe(ev, this.feed.state());
    this.metrics.recordLag(this.lagMeter.clockLagMin());
    this.metrics.wallclockLagSec = this.lagMeter.wallclockLagSec();
    this.playPhase = transitionPlayPhase(this.playPhase, ev);
    this.metrics.playPhase = this.playPhase;

    this.recent.push(ev);
    if (this.recent.length > 30) this.recent.shift();

    // The agent reads momentum off every event, then pushes it to the bar. Markets
    // are NOT opened here — an OUTCOME (shot/goal/miss) must never open a market, only
    // resolve one. Momentum markets are opened from BUILD-UP events on the opener path
    // below (after the resolver branch), so the pressure opens "a shot this spell?" and
    // the shot that follows is what settles it.
    this.momentum.observe(ev);
    this.broadcastMomentum();

    // RESOLVER branch — an event can only ever cause YES (NO comes from the
    // per-tick deadline sweep). Resolver-ish events route here and never reach the
    // opener path below. `shot`/`miss` are YES signals for play/window markets.
    if (
      outcomeFromEvent(ev) !== null ||
      this.isResolverEvent(ev) ||
      ev.type === 'shot' ||
      ev.type === 'miss' ||
      ev.type === 'play_end'
    ) {
      const resolvedSomething = await this.resolveFromEvent(ev);
      // A PENALTY AWARDED that didn't resolve a pending VAR "penalty awarded?" review
      // is itself a fresh bettable moment: "<Team> penalty — will it be SCORED?". The
      // subsequent goal keyEvent settles it YES (parseGoalSource), a miss/save NO via
      // the deadline sweep. Without this the penalty_scored market kind is unreachable.
      if (ev.type === 'penalty' && !resolvedSomething) {
        await this.maybeOpenMarket(ev);
      }
      return;
    }

    if (ev.type === 'final') {
      this.resolveOpenPeriodMarkets('NO');
      return;
    }

    if (ev.type === 'halftime') {
      this.resolveOpenPeriodMarkets('NO');
      return;
    }

    // BUILD-UP path — only non-resolver events reach here (resolvers returned above).
    // First let momentum open a time-boxed WINDOW market for the pressing side, then
    // let the set-piece watcher open a MOMENT market. Both are opened by the build-up,
    // never by an outcome — that's the whole point of moments betting.
    await this.maybeOpenMomentumMarket(this.momentum.read());
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
    if (this.isSamePollSuppressed(ev)) {
      this.metrics.marketsSkipped++;
      this.audit.record('market_skip', { reason: 'same_poll_outcome', type: ev.type });
      return;
    }

    const trigger = await aiTriggerFromEvents([...this.recent], game, {
      homeName: game.home.name,
      awayName: game.away.name,
    });
    if (!trigger) return;

    // Final safety: never open a team-bound market without a team (no "They …").
    if (!trigger.team && requiresTeam(trigger.kind)) return;

    const slot = trigger.slot ?? marketSlot(trigger.kind);
    if (this.hasBlockingMarket(slot)) return;

    if (mk) this.openedMoments.add(mk);

    this.audit.record('watcher_rules', { type: ev.type, text: ev.text.slice(0, 80) });

    await this.openTriggeredMarket(trigger, {
      sequenceId: seqIdOf(ev),
      team: ev.team,
      slot,
      openClockMin: clockMinutes(ev),
      openerType: ev.type,
      logLabel: `type=${ev.type} team=${ev.team ?? 'n/a'} clock=${String(ev.meta?.clock ?? game.clock)}`,
    });
  }

  private isSamePollSuppressed(ev: FeedEvent): boolean {
    const seq = seqIdOf(ev);
    if (seq && this.samePollResolverSeqs.has(seq)) return true;
    const key = resolverBatchKey(ev);
    return !!key && this.samePollResolverKeys.has(key);
  }

  /** Push the agent's momentum read to clients (drives the session momentum bar). */
  private broadcastMomentum(): void {
    const r = this.momentum.read();
    this.momentumLog.push({ bar: r.bar, home: r.home, away: r.away });
    // The per-tick heartbeat makes this grow over a long match — cap it (the sim reads
    // the tail for assertions; production never needs the full history).
    if (this.momentumLog.length > 10_000) this.momentumLog.shift();
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
    if (this.hasBlockingMarket('window')) return;

    // OPEN-SIDE same-poll guard: if the pressing team already has a shot/goal/miss in
    // THIS poll batch, the outcome is effectively known — don't open a market that
    // would just resolve off the same batch (mirrors the set-piece opener's guard).
    if (this.samePollResolverTeams.has(team)) return;

    const game = this.feed.state();
    const name = team === 'home' ? game.home.name : game.away.name;
    if (!name) return;
    // Stamp the open clock so the deadline late-goal rescue works for momentum
    // markets too (a goal/shot the team got at/after open settles YES even if it
    // was reported in a later poll than the resolve window).
    const oc = parseClockKey(game.clock);
    const openClockMin = oc.base + oc.stopp / 100;

    const spec = momentumMarketSpec(name, read.intensity, this.momentumCounter++);
    // POST-GOAL COOL-OFF: don't open a "to SCORE in N min?" right after this team
    // scored — it reads as an instant open+shut off the goal that just happened (and
    // the late-goal rescue could otherwise settle it YES off that same goal). A shot
    // market can still open; only the score market is held back briefly.
    if (
      spec.kind === 'score_in_window' &&
      Date.now() - (this.lastGoalAt.get(team) ?? 0) < SCORE_COOLOFF_MS
    ) {
      return;
    }
    const trigger: MarketTrigger = {
      gameId: game.gameId,
      question: spec.question,
      kind: spec.kind,
      slot: 'window',
      team,
      windowMs: MOMENTUM_BET_WINDOW_MS,
      trueProb: spec.trueProb,
    };

    this.lastMomentumOpenAt.set(team, Date.now());
    await this.openTriggeredMarket(trigger, {
      team,
      slot: 'window',
      openClockMin,
      logLabel: `momentum kind=${spec.kind} team=${team} intensity=${read.intensity.toFixed(1)}`,
    });
  }

  /**
   * Period markets — state-triggered, not tied to a single play.
   * Opens in stoppage/extra time and resolves on goal or whistle.
   */
  private async checkPeriodMarkets(game: GameState): Promise<void> {
    if (game.status === 'final') {
      this.resolveOpenPeriodMarkets('NO');
      return;
    }

    const pk = periodMarketKeyForGame(game);
    if (!pk) {
      this.periodMarketPending = false;
      return;
    }
    if (this.openedMoments.has(pk)) return;
    for (const m of this.engine.list()) {
      if (m.slot === 'period' && (m.status === 'open' || m.status === 'locked')) {
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
    if (inEt) this.extraTimeEntered = true;

    if (this.hasBlockingMarket('period')) {
      this.periodMarketPending = true;
      return;
    }

    this.periodMarketPending = false;
    this.openedMoments.add(pk);

    console.log(`[golazo/feed] period_market_open clock=${game.clock} q="${trigger.question}"`);

    await this.openTriggeredMarket(trigger, {
      team: trigger.team,
      isPeriod: true,
      slot: 'period',
      logLabel: `period clock=${game.clock}`,
    });
  }

  /** True when another unsettled market already owns this slot. */
  private hasBlockingMarket(slot: MarketSlot): boolean {
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if ((m.slot ?? t.slot) === slot) return true;
    }
    return false;
  }

  /** Open a market from a validated trigger — shared by moment + period paths. */
  private async openTriggeredMarket(
    trigger: MarketTrigger,
    opts: {
      sequenceId?: string;
      team?: Team;
      slot?: MarketSlot;
      isPeriod?: boolean;
      openClockMin?: number;
      openerType?: FeedEvent['type'];
      logLabel: string;
    },
  ): Promise<void> {
    const slot = opts.slot ?? trigger.slot ?? marketSlot(trigger.kind);
    if (this.hasBlockingMarket(slot)) return;

    const deadline = resolveDeadlineMs(trigger.kind);
    const armed: MarketTrigger = { ...trigger, slot, resolveWindowMs: deadline };

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
        armed.onChain = { marketSeed: seed, authority: this.chainAuthority };
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
      slot,
      openSeq: this.eventCounter,
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
      this.finalizeMarket(t, outcome);
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

    // Mirror the lock on-chain — but DEFER it by CHAIN_LOCK_GRACE_MS. The engine + UI
    // just locked (anti-snipe unchanged); the chain twin stays Open long enough for an
    // in-flight real-money place_bet (client BET_DELAY_MS hold + devnet confirm) to
    // land before the chain market flips to Locked. Best-effort, fire-and-forget.
    this.scheduleChainLock(t);

    // An outcome that landed DURING the betting window was held — apply it now that
    // betting has closed. This is the guaranteed-window settlement: a real bet window
    // always elapsed first. (finalizeMarket cleans up the tracked entry + timers.)
    if (t.pendingOutcome) {
      const decision = t.pendingOutcome;
      t.pendingOutcome = undefined;
      this.finalizeMarket(t, decision.outcome, {
        voidCause: decision.voidCause,
        voidReason: decision.voidReason,
      });
    }
  }

  /**
   * Schedule the deferred ON-CHAIN lock: fire `chain.lockMarket` CHAIN_LOCK_GRACE_MS
   * after the off-chain engine lock, so a real-money place_bet still in flight (held
   * client-side for BET_DELAY_MS, then a devnet confirm round-trip) can land before
   * the chain market flips to Locked. No-op when the market has no on-chain twin or
   * the lock has already fired. Idempotent.
   */
  private scheduleChainLock(t: TrackedMarket): void {
    if (t.marketSeed === undefined || t.chainLocked || t.chainLockTimer) return;
    const seed = t.marketSeed;
    t.chainLockTimer = setTimeout(() => {
      t.chainLockTimer = undefined;
      if (t.chainLocked) return;
      t.chainLocked = true;
      void this.chain.lockMarket(seed);
    }, this.config.chainLockGraceMs);
  }

  /**
   * Land the deferred on-chain lock NOW (cancelling its grace timer), before the
   * market is settled on-chain. resolve_market accepts Open|Locked, but the operator
   * must never resolve while a bet could still land — so we always lock first. No-op
   * when there is no on-chain twin or the lock already fired. Idempotent.
   */
  private flushChainLock(t: TrackedMarket): void {
    if (t.chainLockTimer) {
      clearTimeout(t.chainLockTimer);
      t.chainLockTimer = undefined;
    }
    if (t.marketSeed !== undefined && !t.chainLocked) {
      t.chainLocked = true;
      void this.chain.lockMarket(t.marketSeed);
    }
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
   * Resolve all markets decided by a feed event. With slots, one goal can settle a
   * moment market, a window market, and a before-whistle period market together.
   */
  private async resolveFromEvent(ev: FeedEvent): Promise<boolean> {
    this.recordResolverClock(ev);

    const targets = this.findMarketsFor(ev);
    let settled = false;
    let handled = targets.length > 0;

    // NOTE: we no longer VOID when an outcome lands while betting is still open. On a
    // ~2-min feed that "early" condition fires constantly and refunds whole pools; the
    // bet-delay HOLD (handleUserBet/acceptHeldBet) is the real latency-arb defense — a
    // user bet placed after the result lands inside its hold gets rejected + refunded.
    // The market itself simply settles YES on the qualifying event.

    for (const target of targets) {
      const m = this.engine.get(target.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      const decision = this.outcomeForTarget(ev, target, m);
      if (!decision) continue;

      // GUARANTEED BETTING WINDOW: an outcome that lands while betting is still OPEN
      // is HELD, not applied — it settles the moment the market locks (see lockMarket).
      // So a market can never open and resolve in the same breath; there is always a
      // real window to bet in. A later YES overrides a held miss/NO; first wins otherwise.
      if (m.status === 'open') {
        const prev = target.pendingOutcome;
        if (!prev || (decision.outcome === 'YES' && prev.outcome !== 'YES')) {
          target.pendingOutcome = decision;
        }
        settled = true;
        continue;
      }

      this.finalizeMarket(target, decision.outcome, {
        voidCause: decision.voidCause,
        voidReason: decision.voidReason,
      });
      settled = true;
    }

    if (ev.type === 'goal' && ev.team) {
      this.lastGoalAt.set(ev.team, Date.now());
      this.feed.applyGoal(ev.team);
      this.server.broadcast({ t: 'game', game: this.feed.state() });
    }

    return handled || settled;
  }

  private outcomeForTarget(
    ev: FeedEvent,
    target: TrackedMarket,
    m: Market,
  ): OutcomeDecision | undefined {
    if (target.isPeriod && ev.type === 'goal') {
      if (target.team && ev.team !== target.team) return undefined;
      return { outcome: 'YES' };
    }

    if (m.kind === 'penalty_awarded') {
      if (ev.type === 'penalty') return { outcome: 'YES' };
      if (ev.type === 'var_penalty_denied') return { outcome: 'NO' };
      return undefined;
    }

    if (m.kind === 'red_card_given') {
      return ev.type === 'red_card' ? { outcome: 'YES' } : undefined;
    }

    if ((ev.type === 'miss' || ev.type === 'play_end') && isGoalQuestionKind(m.kind)) {
      return { outcome: 'NO' };
    }

    // Goal attribution for strict goal-question kinds: ESPN's own goal text decides.
    // 'yes' → YES; 'no' → NO; 'ambiguous' → VOID/refund.
    if (ev.type === 'goal' && isGoalQuestionKind(m.kind)) {
      const verdict = parseGoalSource(ev.text, m.kind);
      if (verdict === 'yes') return { outcome: 'YES' };
      if (verdict === 'ambiguous') {
        return {
          outcome: 'VOID',
          voidCause: 'ambiguous_attribution',
          voidReason: ev.text.slice(0, 80),
        };
      }
      return { outcome: 'NO' };
    }

    return outcomeFromEvent(ev, m.kind) === 'YES' ? { outcome: 'YES' } : undefined;
  }

  /** Find every tracked market this resolution event can decide. */
  private findMarketsFor(ev: FeedEvent): TrackedMarket[] {
    const seq = seqIdOf(ev);
    const targets: TrackedMarket[] = [];

    // 1) Exact correlation by sequenceId.
    if (seq) {
      for (const t of this.tracked.values()) {
        if (t.sequenceId && t.sequenceId === seq) targets.push(t);
      }
    }

    // 2) Fallback by kind/team. One per slot can match the same resolver.
    for (const t of this.tracked.values()) {
      if (targets.includes(t)) continue;
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      // OPEN-BOUNDARY: only events that occur strictly AFTER a market opened may
      // resolve it. The build-up event that opened "a shot this spell?" can't be its
      // own YES — it has to wait for the NEXT shot.
      if (t.openSeq !== undefined && t.openSeq >= this.eventCounter) continue;
      if (this.marketMatchesEvent(t, m, ev)) targets.push(t);
    }
    return targets;
  }

  private marketMatchesEvent(t: TrackedMarket, m: Market, ev: FeedEvent): boolean {
    if (t.isPeriod || m.slot === 'period') {
      if (ev.type !== 'goal') return false;
      return !t.team || ev.team === t.team;
    }
    if (m.kind === 'penalty_awarded') return ev.type === 'penalty' || ev.type === 'var_penalty_denied';
    if (m.kind === 'red_card_given') return ev.type === 'red_card';
    if (t.team && ev.team && t.team !== ev.team) return false;
    if (ev.team && t.team !== ev.team) return false;
    if (m.kind === 'shot_in_window') return ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss';
    if (m.kind === 'score_in_window') return ev.type === 'goal';
    if (isGoalQuestionKind(m.kind)) return ev.type === 'goal' || ev.type === 'miss' || ev.type === 'play_end';
    if (m.kind === 'chance_from_play') return ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss';
    return false;
  }

  /** Apply a final outcome and mirror on-chain. */
  private finalizeMarket(
    target: TrackedMarket,
    outcome: Outcome,
    opts: { voidCause?: string; voidReason?: string } = {},
  ): void {
    const seed = target.marketSeed;
    this.engine.resolve(target.marketId, outcome);
    if (outcome === 'VOID') this.metrics.marketsVoided++;
    else this.metrics.marketsResolved++;
    this.audit.record(
      outcome === 'VOID' ? 'market_void' : 'market_resolve',
      outcome === 'VOID'
        ? { outcome, cause: opts.voidCause ?? 'void', reason: opts.voidReason ?? opts.voidCause ?? 'void' }
        : { outcome },
      target.marketId,
    );
    // Land the deferred chain-lock before settling: the operator must never resolve a
    // chain market that's still Open to new bets. Fires the lock, then settleMarket.
    this.flushChainLock(target);
    this.cleanupTracked(target.marketId);
    if (seed !== undefined) void this.chain.settleMarket(seed, outcome);

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

  /**
   * VOID + refund. The ONLY caller is resetForNewMatch (a feed match-switch), so a
   * VOID can ONLY ever mean "the match we opened this on is gone" — never "the event
   * didn't arrive" (that's a deterministic NO via settleExpired). `cause` is recorded
   * structurally so this invariant is auditable.
   */
  private voidMarket(target: TrackedMarket, cause = 'match_switch', commentary?: string): void {
    const seed = target.marketSeed;
    this.engine.resolve(target.marketId, 'VOID');
    this.metrics.marketsVoided++;
    this.audit.record('market_void', { cause, reason: commentary?.slice(0, 80) ?? cause }, target.marketId);
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
    // Cancel any still-pending deferred chain-lock. finalizeMarket already flushed it
    // (fired) before settling; on a VOID/match-switch we simply drop it (refund anyway).
    if (t.chainLockTimer) {
      clearTimeout(t.chainLockTimer);
      t.chainLockTimer = undefined;
    }
    // Any bet still HELD when the market goes away (resolved/voided) is a snipe
    // candidate — the result landed inside its delay. Void + refund it.
    for (const held of t.pending.values()) {
      clearTimeout(held.timer);
      this.rejectHeldBet(marketId, held, 'play resolved before your bet cleared');
    }
    t.pending.clear();
    this.cleanupPointsHeld(marketId, 'play resolved before your bet cleared');
    this.tracked.delete(marketId);
    if (!t.isPeriod && this.extraTimeEntered) this.periodMarketPending = true;
  }

  /** Refund paper stakes still in the anti-snipe hold when a market ends. */
  private cleanupPointsHeld(marketId: string, reason: string): void {
    const pending = this.pointsHeld.get(marketId);
    if (!pending) return;
    for (const held of pending.values()) {
      clearTimeout(held.timer);
      this.server.emitPoints(
        this.server.pointsManager.releaseHeldBet(held.userId, marketId, reason),
      );
    }
    pending.clear();
    this.pointsHeld.delete(marketId);
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
      // Mirror the settled outcome into every room (credits room points in lockstep).
      rooms.onGlobalMarketResolve(m);
    });
  }

  /**
   * Real-money bet. With betDelayMs > 0, held briefly as an optional anti-snipe
   * gate; default 0 places immediately.
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

    if (this.config.betDelayMs <= 0) {
      try {
        this.engine.placeBet(msg.marketId, msg.userId, msg.side, msg.stake);
      } catch {
        this.rejectHeldBet(msg.marketId, { ...msg }, 'market not open');
      }
      return;
    }

    const held: HeldBet = {
      userId: msg.userId,
      side: msg.side,
      stake: msg.stake,
      timer: setTimeout(() => this.acceptHeldBet(msg.marketId, msg.userId), this.config.betDelayMs),
    };
    t.pending.set(msg.userId, held);
  }

  /** Bet-delay elapsed: place the held bet once the hold clears (lock is OK). */
  private acceptHeldBet(marketId: string, userId: string): void {
    const t = this.tracked.get(marketId);
    const held = t?.pending.get(userId);
    if (!t || !held) return;
    t.pending.delete(userId);
    const m = this.engine.get(marketId);
    if (m && m.status !== 'resolved' && m.status !== 'void') {
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
      'play resolved before your bet cleared',
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
    if (pending.has(msg.userId)) {
      this.server.emitPoints({
        rejected: {
          userId: msg.userId,
          marketId: msg.marketId,
          stake: msg.stake,
          reason: 'bet already pending',
        },
      });
      return;
    }

    const holdFx = this.server.pointsManager.holdBet(
      msg.userId,
      msg.marketId,
      msg.side,
      msg.stake,
    );
    if (holdFx.rejected) {
      this.server.emitPoints(holdFx);
      return;
    }
    this.server.emitPoints(holdFx);

    const held: HeldBet = {
      userId: msg.userId,
      side: msg.side,
      stake: msg.stake,
      timer: setTimeout(
        () => this.acceptPointsHeldBet(msg.marketId, msg.userId),
        this.config.pointsBetDelayMs,
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
    if (m && m.status !== 'resolved' && m.status !== 'void') {
      const effects = this.server.pointsManager.confirmHeldBet(userId, marketId);
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
      'play resolved before your bet cleared',
    );
  }

  private rejectPointsHeldBet(
    marketId: string,
    held: { userId: string; stake: number },
    reason: string,
  ): void {
    const effects = this.server.pointsManager.releaseHeldBet(
      held.userId,
      marketId,
      reason,
    );
    if (effects.rejected || effects.state) {
      this.server.emitPoints(effects);
      return;
    }
    this.server.emitPoints({
      rejected: {
        userId: held.userId,
        marketId,
        stake: held.stake,
        reason,
      },
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
  return [...events].sort((a, b) => {
    const ac = clockMinutes(a) ?? 0;
    const bc = clockMinutes(b) ?? 0;
    if (ac !== bc) return ac - bc;
    const ra = isOutcomeEvent(a) ? 1 : 0;
    const rb = isOutcomeEvent(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return openerPriority(a.type) - openerPriority(b.type);
  });
}

function isOutcomeEvent(ev: FeedEvent): boolean {
  return (
    ev.type === 'goal' ||
    ev.type === 'miss' ||
    ev.type === 'shot' ||
    ev.type === 'play_end' ||
    ev.type === 'yellow_card' ||
    ev.type === 'red_card' ||
    ev.type === 'var_penalty_denied'
  );
}

function resolverBatchKey(ev: FeedEvent): string | undefined {
  if (!ev.team) return undefined;
  const clock = typeof ev.meta?.clock === 'string' ? ev.meta.clock : '';
  const { base, stopp } = parseClockKey(clock);
  if (base <= 0) return undefined;
  return `${ev.team}:${base}+${stopp}`;
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
    // "a shot this spell?" — a goal or shot the team recorded at/after open is a
    // YES even if it landed in a later poll than the resolve window (lastResolverByTeam
    // records goal+miss, both of which qualify as a shot attempt).
    kind === 'shot_in_window' ||
    kind === 'chance_from_play' ||
    kind === 'goal_from_open_play' ||
    kind === 'goal_in_stoppage' ||
    kind === 'goal_in_extra_time'
  );
}
