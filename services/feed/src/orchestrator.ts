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
  type FeedEventType,
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
  buildCountSlotTrigger,
  buildEventSlotTrigger,
  buildVersusTrigger,
  clockMinutes,
  goalAlreadyHappenedForChance,
  isDefensiveSetPiece,
  isStalePlay,
  KEY_EVENT_ONLY_OPENERS,
  bettingClosesAt,
  isGoalMomentKind,
  marketSlot,
  MOMENTUM_OPEN_THRESHOLD,
  MOMENTUM_WINDOW_LANES,
  MOMENTUM_PER_TEAM_CAP,
  openerPriority,
  knobFor,
  PERIOD_MARKET,
  periodMarketKeyForGame,
  resolveDeadlineMs,
  countEventTypes,
  countLine,
  isCountKind,
  isWhichSideNextKind,
  decisiveEventTypes,
  inWhistleZone,
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
import { QuestionEnhancer } from './ai/enhancer';
import { MarketDirector, type MarketProposal } from './ai/director';
import { CommentaryBuffer } from './ai/commentaryBuffer';
import { AuditLog } from './observability/auditLog';
import { FeedMetrics } from './observability/metrics';
import { LagMeter } from './observability/lagMeter';
import { ROOM_RAKE } from '@golazo/core';
import { BotSwarm, PointsBotSwarm, resolveBotConfig } from './bots';
import { createChainOperator, type FeedChainOperator } from './chain';
import { FeedServer } from './server';
import { momentKey, parseClockKey } from './feed/espn';

/**
 * Betting window for a momentum-opened market — kept SHORT (the play is live), but
 * lifted 10s→20s as the measured sweet spot: meaningfully more bettable time without
 * abandoning a snappy live window. (True 80% BETTABLE is unreachable with short windows;
 * 80%+ VISIBLE is — see the keep-alive opener + 2 lanes.)
 */
const MOMENTUM_BET_WINDOW_MS = 20_000;
/**
 * Min gap between momentum-opened markets for the SAME team. Tuned DOWN for volume
 * (momentum time-boxed markets are now the main opener path) — this just stops ONE
 * spell printing the same line back-to-back.
 */
const MOMENTUM_OPEN_COOLDOWN_MS = 8_000;
/**
 * After a team SCORES, suppress its momentum "to SCORE in N min?" market for this long.
 * A score market that pops right after a goal reads as an instant open+shut (and the
 * late-goal rescue could even settle it YES off the goal that just happened).
 */
const SCORE_COOLOFF_MS = 25_000;
/**
 * After a goal, a teamless "a goal in the next few minutes?" market reads as nonsense (the
 * game just restarted from the centre circle). Suppress the event-slot goal-window market
 * for this long after ANY goal — rotate to the booking market instead.
 */
const GOAL_WINDOW_COOLOFF_MS = 60_000;
/** Per-player FORM tracking (mirrors team momentum, keyed by ESPN athlete id). */
const PLAYER_DECAY = 0.85;
const PLAYER_HOT_THRESHOLD = 3.0; // ~one tagged shot + follow-up threat (was 4.25)
const PLAYER_OPEN_COOLDOWN_MS = 90_000; // per-player (was 150s)
const PLAYER_BACK_TO_BACK_COOLDOWN_MS = 120_000;
const SET_PIECE_UNTAKEN_GRACE_MS = 20_000;
const SET_PIECE_AFTER_TAKEN_GRACE_MS = 25_000;
const SET_PIECE_MAX_UNCONFIRMED_MS = 180_000;
/**
 * FLOW PACING — minimum gap between any two market opens, so the board drips at a clean,
 * deliberate rhythm instead of dumping a whole ESPN poll-batch at once ("nothing, then 2
 * at once"). The high-frequency, fungible openers (momentum, player) are GATED by this;
 * concrete event-driven markets (set-piece/penalty/VAR/period) still open promptly but
 * RESET the timer, so nothing else lands right on top of them. Pure presentation pacing —
 * volume is unchanged (the slot/cooldown guards already cap concurrency); this only
 * staggers WHEN opens surface, which is most of the "feels clean" perception win.
 */
const MIN_OPEN_SPACING_MS = 8_000;
/**
 * Clock-skew tolerance for the anti-arb resolver-taint check. We only treat an event as
 * "happened during betting" (tainted) when its wallclock is more than this before betting
 * closed, so sub-second skew between our clock and ESPN's wallclock never wrongly drops a
 * legitimate just-after-close event. Small vs the ~30-50s arb window the lag opens.
 */
const RESOLVER_SKEW_GRACE_MS = 1_500;
/**
 * The feed lag the resolve deadlines were tuned to absorb. When the MEASURED lag exceeds
 * this, a legit in-window goal may still be in flight past a goal-market's deadline — so we
 * hold the NO for the excess (capped) instead of settling NO on a goal that already happened.
 * This is what stops "a goal occurred but the shot/goal market resolved NO" when lag spikes.
 */
const EXPECTED_FEED_LAG_MS = 55_000;
const MAX_LATE_GOAL_GRACE_MS = 45_000;
/** EVENT-slot heartbeat: open one teamless card/goal-window market roughly this often. */
const EVENT_SLOT_INTERVAL_MS = 180_000; // ~3 min
/** COUNT-slot heartbeat: open one over_corners/over_shots market roughly this often. */
const COUNT_SLOT_INTERVAL_MS = 240_000; // ~4 min
/** VERSUS-slot heartbeat: open one which-side-next contest roughly this often. */
const VERSUS_SLOT_INTERVAL_MS = 150_000; // ~2.5 min
/** Hydration/cooling break can't run longer than this — auto-resume so a missed ESPN
 *  "end delay" marker never freezes the board for the rest of the match. */
const MAX_BREAK_MS = 180_000;
/** Per-market bookkeeping the orchestrator keeps alongside the engine's Market. */
interface TrackedMarket {
  marketId: string;
  /** sequenceId of the attack event that opened it, for resolution correlation. */
  sequenceId: string | undefined;
  /** team the attack belongs to, so we know whose score to bump on a goal. */
  team: Team | undefined;
  bots: BotSwarm;
  pointsBots: PointsBotSwarm;
  /** OVER/UNDER count markets: running count of qualifying events since open. */
  counter?: { countTypes: ReadonlySet<FeedEventType>; line: number; count: number };
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
  /** Player market (kind 'player_to_score'): the ESPN athlete id that must score for
   *  YES — resolution matches a goal's scorer participant by this id. */
  playerId?: string;
  /** Set-piece goal markets do not time out NO until the kick/corner is actually taken. */
  setPieceTakenAt?: number;
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
  private readonly commentary = new CommentaryBuffer();
  /** AI question enhancer (off-hot-path, fail-open). Constructed in the constructor. */
  private enhancer!: QuestionEnhancer;
  private enhancerTimer?: ReturnType<typeof setInterval>;
  /** AI market director (off-hot-path, fail-open, palette-bounded). Constructed below. */
  private director!: MarketDirector;
  private directorTimer?: ReturnType<typeof setInterval>;
  /** Wall-clock of the last momentum-opened market per team (cooldown). */
  private readonly lastMomentumOpenAt = new Map<Team, number>();
  /** Wall-clock of each team's last goal — gates the post-goal score-market cool-off. */
  private readonly lastGoalAt = new Map<Team, number>();
  /** The EXACT ESPN wallclock of each team's last goal (only set when the keyEvent carried
   *  one) — so the late-goal rescue can prove a goal happened AFTER betting closed. When it's
   *  absent the rescue falls back to the match clock (lastResolverByTeam vs openClockMin). */
  private readonly lastGoalWallclockByTeam = new Map<Team, number>();
  /** Per-player decaying FORM (keyed by ESPN athlete id) — drives player markets. */
  private readonly playerForm = new Map<
    string,
    { name: string; team: Team; score: number; lastOpenAt: number }
  >();
  private lastPlayerMarketId: string | undefined;
  private lastPlayerMarketAt = 0;
  /** Wall-clock of the last market that surfaced — drives the FLOW PACING min-gap. */
  private lastOpenReleaseAt = 0;
  /** Heartbeat (event/count) lane cadence — seeded one interval into the match. */
  private lastEventSlotOpenAt = 0;
  private lastCountSlotOpenAt = 0;
  private eventSlotCounter = 0;
  private countSlotCounter = 0;
  private lastVersusOpenAt = 0;
  private versusCounter = 0;
  private heartbeatSeeded = false;
  /** True during a hydration/cooling break — openers + the NO sweep pause. */
  private breakPaused = false;
  /** Wall-clock the current break started (for the MAX_BREAK_MS auto-resume). */
  private breakStartedAt = 0;
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
        // HONEST label: markets are ALWAYS decided by rules; AI (if active) only
        // polishes question text. Reports the enhancer's real state, not key-presence.
        watcher: this.enhancer.active
          ? this.enhancer.producing
            ? 'rules+ai-enhance'
            : 'rules+ai-enhance(idle)'
          : 'rules',
        // The director's HONEST state: markets it proposes are still validated + opened by
        // the deterministic engine; this reports whether the AI is actively proposing.
        director: this.director.active
          ? this.director.producing
            ? `ai-direct(${this.director.queued} queued)`
            : 'ai-direct(idle)'
          : 'off',
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

    // AI question ENHANCER — off the hot path, fail-open. OFF unless explicitly enabled
    // (AI_ENHANCER=1) AND keyed. Only ever rewrites question TEXT; never decides/resolves.
    this.enhancer = new QuestionEnhancer({
      apiKey: this.config.anthropicApiKey,
      enabled: this.config.aiEnhancerEnabled,
      model: this.config.aiModel,
      timeoutMs: this.config.aiTimeoutMs,
      refreshMs: this.config.aiRefreshMs,
      matchTokenBudget: this.config.aiMatchTokenBudget,
      scoreWindowMins: Math.max(1, Math.round(resolveDeadlineMs('score_in_window') / 60_000)),
      commentary: this.commentary,
      getContext: () => ({ game: this.feed.state(), momentum: this.momentum.read() }),
    });

    this.director = new MarketDirector({
      apiKey: this.config.anthropicApiKey,
      enabled: this.config.aiDirectorEnabled,
      model: this.config.aiModel,
      timeoutMs: this.config.aiTimeoutMs,
      refreshMs: this.config.aiRefreshMs,
      matchTokenBudget: this.config.aiMatchTokenBudget,
      commentary: this.commentary,
      getContext: () => ({
        game: this.feed.state(),
        momentum: this.momentum.read(),
        secondsSinceGoal: this.secondsSinceLastGoal(),
      }),
      onReject: (reason, raw) =>
        this.audit.record('director_reject', { reason, raw: JSON.stringify(raw).slice(0, 200) }),
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

    // Enhancer's SLOW background generator — its own timer, never on the open path.
    if (this.enhancer.active) {
      this.enhancerTimer = setInterval(
        () => void this.enhancer.refresh(Date.now()),
        this.config.aiRefreshMs,
      );
    }

    // Director's SLOW proposal generator — its own timer, never on the open path. The opener
    // reads pre-validated proposals synchronously (proposeNext); this just refills the pool.
    if (this.director.active) {
      this.directorTimer = setInterval(
        () => void this.director.refresh(Date.now()),
        this.config.aiRefreshMs,
      );
    }
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

  /** Sim/test hook: drive a real-money bet through the live handler (latency-arb guards et al). */
  simBet(marketId: string, userId: string, side: 'YES' | 'NO', stake: number): void {
    this.handleUserBet({ t: 'bet', marketId, userId, side, stake });
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
    if (this.enhancerTimer) clearInterval(this.enhancerTimer);
    if (this.directorTimer) clearInterval(this.directorTimer);
    for (const t of this.tracked.values()) {
      t.bots.cancel();
      t.pointsBots.cancel();
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
    // Auto-resume a hydration break if ESPN's "end delay" was missed — the board must
    // never freeze for the rest of the match on a dropped marker.
    if (this.breakPaused && Date.now() - this.breakStartedAt > MAX_BREAK_MS) this.endBreak();
    this.server.broadcast({ t: 'game', game });
    this.server.roomManager.lockExpiredMarkets();
    await this.checkPeriodMarkets(game);

    const livePlay = game.status === 'live' && !this.breakPaused;

    // HEARTBEAT: relax momentum one tick BEFORE broadcasting so the bar keeps breathing
    // and a quiet spell drifts back toward neutral (observe() only decays per-event).
    if (livePlay) this.momentum.decayTick();
    this.broadcastMomentum();

    // CADENCE — the fix for the dead board: open the momentum (WINDOW) market on the
    // HEARTBEAT, not only on sparse feed events. Real fixtures supply openable events
    // 5–13 match-minutes apart, so an event-only opener left the board EMPTY 55–61% of
    // the match (gaps up to ~10 min). Running it each tick off the standing read keeps a
    // market basically always live WITHOUT spam: the single-slot lock (a window market
    // stays LOCKED 90–120s after its 10s bet window) caps volume, not the cooldown. The
    // per-tick decay above keeps it honest — it only fires while pressure is still real.
    if (livePlay) await this.maybeOpenMomentumMarket(this.momentum.read());

    // RULE-BASED HEARTBEAT OPENERS — the 'event' (booking / goal-window) and 'count'
    // (over/under) lanes aren't tied to a single play, so they open on a clock (live,
    // not on a break), respecting the flow pacer + single-occupancy per slot. This is
    // what makes several varied markets show at once without one play having to fire them.
    if (livePlay) {
      // Seed the cadence at the first live tick so the first event/count market opens one
      // interval into the match, never as a kickoff dump at t=0.
      if (!this.heartbeatSeeded) {
        this.heartbeatSeeded = true;
        this.lastEventSlotOpenAt = Date.now();
        this.lastCountSlotOpenAt = Date.now();
        this.lastVersusOpenAt = Date.now();
      }
      // HT/FT BOUNDARY GUARD: don't open new booking/goal-window/over-under markets in
      // stoppage — the whistle would cut their window short. The stoppage period market
      // ("goal before the half?") is the right one for that moment.
      if (!inWhistleZone(game)) {
        await this.maybeOpenEventSlotMarket(game);
        await this.maybeOpenCountSlotMarket(game);
      }
    }

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
    this.commentary.push(ev); // feeds the off-path enhancer's narrative context
    this.bumpCountMarkets(ev); // over/under count markets: YES the instant they cross the line
    this.resolveWhichSideMarkets(ev); // which-side contests: decided by the next threat (any team)
    if (this.recent.length > 30) this.recent.shift();

    // The agent reads momentum off every event, then pushes it to the bar. Markets
    // are NOT opened here — an OUTCOME (shot/goal/miss) must never open a market, only
    // resolve one. Momentum markets are opened from BUILD-UP events on the opener path
    // below (after the resolver branch), so the pressure opens "a shot this spell?" and
    // the shot that follows is what settles it.
    this.momentum.observe(ev);
    this.observePlayer(ev);
    this.broadcastMomentum();

    // HYDRATION/COOLING break: ESPN emits start/end "delay" as a calm event carrying
    // meta.delay. Pause openers + the NO sweep for the break (auto-resumes in tick()).
    if (ev.meta?.delay === 'start') this.beginBreak();
    else if (ev.meta?.delay === 'end') this.endBreak();

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

    // A CORNER both RESOLVES a window market ("a shot OR corner this spell?") and OPENS a
    // set-piece market (goal_from_corner). The resolver gate above returns before the opener,
    // so it can't do both — resolve window markets on the corner HERE, then fall through to
    // the opener below. (Count + which-side markets already handle corners in their own
    // per-event passes; recordResolverClock ignores corners, so no false goal-rescue.)
    if (ev.type === 'corner') {
      await this.resolveFromEvent(ev);
    }

    // BUILD-UP path — only non-resolver events reach here (resolvers returned above).
    // Momentum (WINDOW) + a PLAYER market for the hottest in-form player open in
    // PARALLEL lanes, off flowing play — so they PAUSE during a hydration/cooling break.
    // HT/FT BOUNDARY GUARD: in stoppage time the whistle is imminent, so a short
    // play-dependent market opened now would be cut off → suppress momentum/player/versus
    // opens and let the "goal before the half?" period market carry that moment.
    const liveGame = this.feed.state();
    if (!this.breakPaused && !inWhistleZone(liveGame)) {
      // The AI DIRECTOR gets FIRST pick of free slots (its proposals are mood/clock-aware);
      // whatever it doesn't fill, the deterministic rule openers below cover (fail-open floor).
      await this.maybeOpenDirectorMarket(liveGame);
      await this.maybeOpenMomentumMarket(this.momentum.read());
      await this.maybeOpenPlayerMarket();
      // WHICH-SIDE-NEXT contest — opened EVENT-DRIVEN off a build-up attacking move, so a
      // decisive event (the next threat) is demonstrably imminent and the contest resolves
      // YES/NO rather than voiding into a quiet spell. Its own slot/interval/pressure gates
      // pace it; the opening event can't resolve it (open-boundary guard).
      await this.maybeOpenVersusMarket(liveGame);
    }
    // Set-piece / VAR markets are event-driven (a free kick, a VAR review — which is
    // itself often the cause of a delay), so they open even during a break; the
    // stale-lag gates inside maybeOpenMarket still prevent dead-ball opens.
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
  /** Count live (open|locked) momentum WINDOW markets, optionally for one team. */
  private countOpenMomentumMarkets(team?: Team): number {
    let n = 0;
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if ((m.slot ?? t.slot) !== 'window') continue;
      if (team !== undefined && t.team !== team) continue;
      n++;
    }
    return n;
  }

  /** A team is at its momentum cap (=1) when it already holds a live window market. */
  private hasOpenMomentumMarketFor(team: Team): boolean {
    return this.countOpenMomentumMarkets(team) >= MOMENTUM_PER_TEAM_CAP;
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
    // FLOW PACING: drip momentum markets at a clean rhythm — never stack a second one (e.g.
    // the other lane) onto the same beat. The keep-alive re-offers next tick, so this only
    // staggers timing, not volume.
    if (Date.now() - this.lastOpenReleaseAt < MIN_OPEN_SPACING_MS) return;

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
    // ENHANCER: swap ONLY the human question for a richer AI line if one is pooled,
    // else keep the deterministic template. Chosen BEFORE open so the on-chain
    // question_hash matches the displayed text. Everything else stays template-decided.
    const question = this.enhancer.pick(team, spec.kind, spec.question, Date.now());
    const trigger: MarketTrigger = {
      gameId: game.gameId,
      question,
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
   * Per-PLAYER form, read off ESPN's structured actor (meta.player). A shot/goal/miss
   * by a named player builds their form and decays every other player's — so the
   * "hottest" player is whoever's been most threatening lately.
   */
  private observePlayer(ev: FeedEvent): void {
    const p = ev.meta?.player as { id?: string; name?: string } | undefined;
    const w =
      ev.type === 'shot' ? 2.8 :
      ev.type === 'miss' ? 2.5 :
      ev.type === 'dangerous_attack' ? 1.2 :
      ev.type === 'attack' ? 0.8 :
      0;
    if (!p?.id || !p.name || !ev.team || w === 0) return;
    for (const f of this.playerForm.values()) f.score *= PLAYER_DECAY;
    const prev = this.playerForm.get(p.id);
    this.playerForm.set(p.id, {
      name: p.name,
      team: ev.team,
      score: (prev?.score ?? 0) + w,
      lastOpenAt: prev?.lastOpenAt ?? 0,
    });
  }

  /**
   * PLAYER market — "Will <player> SCORE in the next few minutes?" for the hottest
   * in-form player. A PARALLEL lane (slot 'player') so it co-exists with the
   * moment/window/period markets. Opened off FORM (never an outcome); resolved YES
   * only by a goal whose scorer participant matches this athlete id, else NO via the
   * deadline sweep.
   */
  private async maybeOpenPlayerMarket(): Promise<void> {
    if (this.hasBlockingMarket('player')) return;
    // NOTE: player markets are NOT flow-gated — they're already rare (150s per-player
    // cooldown, single slot) so they never burst; gating them only blocks a legit one.
    const candidates: { id: string; name: string; team: Team; score: number }[] = [];
    for (const [id, f] of this.playerForm) {
      if (f.score < PLAYER_HOT_THRESHOLD) continue;
      if (Date.now() - f.lastOpenAt < PLAYER_OPEN_COOLDOWN_MS) continue;
      candidates.push({ id, name: f.name, team: f.team, score: f.score });
    }
    candidates.sort((a, b) => b.score - a.score);

    let best = candidates[0];
    if (
      best &&
      best.id === this.lastPlayerMarketId &&
      Date.now() - this.lastPlayerMarketAt < PLAYER_BACK_TO_BACK_COOLDOWN_MS
    ) {
      best = candidates.find((c) => c.id !== this.lastPlayerMarketId) ?? best;
    }
    if (!best) return;

    const game = this.feed.state();
    const oc = parseClockKey(game.clock);
    const openClockMin = oc.base + oc.stopp / 100;
    const trigger: MarketTrigger = {
      gameId: game.gameId,
      question: pickPlayerQuestion(best.name, this.momentumCounter++),
      kind: 'player_to_score',
      slot: 'player',
      team: best.team,
      windowMs: MOMENTUM_BET_WINDOW_MS,
      trueProb: 0.12,
    };
    const f = this.playerForm.get(best.id);
    if (f) f.lastOpenAt = Date.now();
    this.lastPlayerMarketId = best.id;
    this.lastPlayerMarketAt = Date.now();
    await this.openTriggeredMarket(trigger, {
      team: best.team,
      slot: 'player',
      openClockMin,
      playerId: best.id,
      logLabel: `player who=${best.name} score=${best.score.toFixed(1)}`,
    });
  }

  /** Enter a hydration/cooling break: pause openers + the NO sweep until it ends. */
  private beginBreak(): void {
    if (this.breakPaused) return;
    this.breakPaused = true;
    this.breakStartedAt = Date.now();
    console.log('[golazo/feed] break_start — markets paused (cooling/hydration)');
  }

  /** Resume after a break (ESPN "end delay", or the MAX_BREAK_MS auto-resume). */
  private endBreak(): void {
    if (!this.breakPaused) return;
    this.breakPaused = false;
    const breakMs = Date.now() - this.breakStartedAt;
    // The countdown shouldn't drain during a break — push every open/locked market's resolve
    // deadline forward by however long the break lasted, so a market doesn't settle the instant
    // play resumes (it gets back exactly the time the break ate). settleExpired was paused for
    // the break, so nothing resolved meanwhile; this keeps the post-break timers honest.
    if (breakMs > 0) {
      for (const t of this.tracked.values()) {
        const m = this.engine.get(t.marketId);
        if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
        this.extendMarketResolve(t, m.resolveAt + breakMs);
      }
    }
    console.log(`[golazo/feed] break_end — markets resumed (+${Math.round(breakMs / 1000)}s deadlines)`);
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
    if (game.status === 'halftime') {
      // Half-time usually arrives as a STATUS transition, not a keyEvent — settle the
      // "goal before half-time?" period market NO here so it can't hang to full time.
      this.resolveOpenPeriodMarkets('NO');
      return;
    }
    if (this.breakPaused) return; // don't open period markets mid-break

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
    // The 'window' (momentum) slot is MULTI-LANE: allow up to MOMENTUM_WINDOW_LANES
    // concurrent momentum markets so the board stays populated (one per team). Every
    // other slot stays strictly single-occupancy.
    if (slot === 'window') return this.countOpenMomentumMarkets() >= MOMENTUM_WINDOW_LANES;
    for (const t of this.tracked.values()) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if ((m.slot ?? t.slot) === slot) return true;
    }
    return false;
  }

  /** Open a market from a validated trigger — shared by moment + period paths. */
  /**
   * OVER/UNDER COUNT pass — runs for EVERY processed event (a counting event like a
   * corner is an OPENER that never reaches the resolve path, so the count can't live
   * there). Bumps each open/locked count market whose counted types include this event,
   * and settles YES the instant its running count EXCEEDS the line. Below the line it
   * waits; the one-NO-writer deadline sweep settles NO. NEVER writes NO, never touches a
   * non-count market — purely the count-crossing → YES authority.
   */
  private bumpCountMarkets(ev: FeedEvent): void {
    for (const t of [...this.tracked.values()]) {
      if (!t.counter || !t.counter.countTypes.has(ev.type)) continue;
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      // Open-boundary: the event that OPENED the market can't also count toward it.
      if (t.openSeq !== undefined && t.openSeq >= this.eventCounter) continue;
      // Anti-arb: an event that happened during betting is tainted — don't count it.
      if (this.resolverIsTainted(ev, m, t)) continue;
      t.counter.count += 1;
      if (t.counter.count <= t.counter.line) continue;
      // Crossed → YES. Held while OPEN (applied at lock, like every early outcome);
      // settled immediately once locked.
      if (m.status === 'open') {
        if (!t.pendingOutcome || t.pendingOutcome.outcome !== 'YES') {
          t.pendingOutcome = { outcome: 'YES' };
        }
      } else {
        this.finalizeMarket(t, 'YES');
      }
    }
  }

  /**
   * WHICH-SIDE-NEXT resolution — runs for EVERY event (like bumpCountMarkets), NOT via the
   * resolver-branch gate. This matters: a decisive event can be a `corner` or
   * `dangerous_attack`, which that gate does NOT route into resolveFromEvent — so resolving
   * which-side here is the ONLY way the opponent-first → NO path fires for those types.
   * The first decisive event by EITHER team decides the contest: the market's team does it
   * first → YES, the OTHER team first → NO. Held while OPEN (the guaranteed betting window),
   * settled immediately once locked. FIRST decisive event wins — a later same-team threat
   * must NOT flip a held "the other team went first" NO. Neither team by the deadline →
   * VOID/refund (settleExpired), never NO. This is the SOLE resolver for which-side kinds
   * (they're excluded from outcomeForTarget/marketMatchesEvent so nothing double-handles).
   */
  private resolveWhichSideMarkets(ev: FeedEvent): void {
    if (!ev.team) return; // a decisive event must be attributable to a side
    for (const t of [...this.tracked.values()]) {
      const m = this.engine.get(t.marketId);
      if (!m || (m.status !== 'open' && m.status !== 'locked')) continue;
      if (!isWhichSideNextKind(m.kind)) continue;
      if (!decisiveEventTypes(m.kind).has(ev.type)) continue;
      // Open-boundary: the event that OPENED the contest can't be its own decider.
      if (t.openSeq !== undefined && t.openSeq >= this.eventCounter) continue;
      // Anti-arb: a decisive event that happened during betting is tainted — skip it.
      if (this.resolverIsTainted(ev, m, t)) continue;
      const outcome: Outcome = ev.team === t.team ? 'YES' : 'NO';
      if (m.status === 'open') {
        if (!t.pendingOutcome) t.pendingOutcome = { outcome }; // first decisive event wins
      } else {
        this.finalizeMarket(t, outcome);
      }
    }
  }

  /**
   * EVENT-slot heartbeat — a teamless "a booking in the next few minutes?" /
   * "a goal in the next few minutes? (either team)" market opened on a clock, alternating
   * the two kinds. Single-occupancy ('event' slot), flow-paced; resolves cleanly (YES on
   * the matching event, NO at deadline).
   */
  private async maybeOpenEventSlotMarket(game: GameState): Promise<void> {
    if (this.hasBlockingMarket('event')) return;
    if (Date.now() - this.lastEventSlotOpenAt < EVENT_SLOT_INTERVAL_MS) return;
    if (Date.now() - this.lastOpenReleaseAt < MIN_OPEN_SPACING_MS) return; // global flow pacer

    let trigger = buildEventSlotTrigger(game.gameId, this.eventSlotCounter);
    // POST-GOAL: don't open "a goal in the next few minutes?" right after a goal (the game
    // just kicked off again) — rotate to the booking market instead.
    if (trigger.kind === 'goal_in_window' && this.recentGoalCooloff(GOAL_WINDOW_COOLOFF_MS)) {
      this.eventSlotCounter++;
      trigger = buildEventSlotTrigger(game.gameId, this.eventSlotCounter);
    }

    const beforeOpened = this.metrics.marketsOpened;
    await this.openTriggeredMarket(trigger, { slot: 'event', logLabel: `heartbeat kind=${trigger.kind}` });
    if (this.metrics.marketsOpened > beforeOpened) {
      this.lastEventSlotOpenAt = Date.now();
      this.eventSlotCounter++;
    }
  }

  /**
   * COUNT-slot heartbeat — an over/under "more than N corners / shots in the next few
   * minutes?" market opened on a clock, alternating the two kinds. Single-occupancy
   * ('count' slot), flow-paced. Settled by the running event counter (YES on crossing,
   * NO at deadline) — never a single YES event.
   */
  private async maybeOpenCountSlotMarket(game: GameState): Promise<void> {
    if (this.hasBlockingMarket('count')) return;
    if (Date.now() - this.lastCountSlotOpenAt < COUNT_SLOT_INTERVAL_MS) return;
    if (Date.now() - this.lastOpenReleaseAt < MIN_OPEN_SPACING_MS) return; // global flow pacer

    const trigger = buildCountSlotTrigger(game.gameId, this.countSlotCounter);

    const beforeOpened = this.metrics.marketsOpened;
    await this.openTriggeredMarket(trigger, {
      slot: 'count',
      logLabel: `heartbeat kind=${trigger.kind} line=${countLine(trigger.kind)}`,
    });
    if (this.metrics.marketsOpened > beforeOpened) {
      this.lastCountSlotOpenAt = Date.now();
      this.countSlotCounter++;
    }
  }

  /**
   * AI DIRECTOR open path — SYNCHRONOUSLY read one pre-validated proposal for a FREE slot and
   * open it. Never awaits the model (the proposal pool is filled off-timer); fails open to the
   * rule openers when the director is off/empty. Respects the same single-occupancy slots and
   * the global flow pacer, so the AI can never burst or double-fill. The proposal already
   * passed the palette validation wall, so kind/slot/deadline/team/question are all sound.
   */
  private async maybeOpenDirectorMarket(game: GameState): Promise<void> {
    if (!this.director.active) return;
    if (Date.now() - this.lastOpenReleaseAt < MIN_OPEN_SPACING_MS) return; // global flow pacer
    const proposal: MarketProposal | undefined = this.director.proposeNext(
      Date.now(),
      (slot) => !this.hasBlockingMarket(slot),
    );
    if (!proposal) return;

    const trigger: MarketTrigger = {
      gameId: game.gameId,
      question: proposal.question,
      kind: proposal.kind,
      slot: proposal.slot,
      ...(proposal.team ? { team: proposal.team } : {}),
      windowMs: proposal.windowMs,
      trueProb: proposal.trueProb,
    };
    await this.openTriggeredMarket(trigger, {
      slot: proposal.slot,
      ...(proposal.team ? { team: proposal.team } : {}),
      logLabel: `director kind=${proposal.kind}${proposal.team ? ' team=' + proposal.team : ''} rel=${proposal.relevance.toFixed(2)}`,
    });
  }

  /**
   * VERSUS-slot heartbeat — a "which team does the next shot/corner/goal?" CONTEST,
   * opened on a clock, alternating the kind and which team is the YES side. Single-
   * occupancy ('versus'), flow-paced. The fun, balanced family: always a winner (YES the
   * named team, NO the other), VOID only if neither team does it in the window. Resolved
   * by the decisive-event path (outcomeForTarget), never the deadline NO.
   */
  private async maybeOpenVersusMarket(game: GameState): Promise<void> {
    if (this.hasBlockingMarket('versus')) return;
    if (Date.now() - this.lastVersusOpenAt < VERSUS_SLOT_INTERVAL_MS) return;
    if (Date.now() - this.lastOpenReleaseAt < MIN_OPEN_SPACING_MS) return; // global flow pacer

    // Only open a "next shot/corner — which team?" CONTEST during genuine attacking play —
    // when there's real pressure, the next shot/corner is imminent so the contest resolves
    // YES/NO; in a quiet spell it would just VOID/refund (anticlimactic). Gating on live
    // pressure both raises the resolve rate and stops the board filling with refunds. (The
    // AI director opens these with even sharper timing later; this is the deterministic floor.)
    const mood = this.momentum.read();
    if (mood.home + mood.away < 2.5) return;

    // Auto-open only the BROAD "who threatens next?" contest (next_shot resolves on any
    // shot/corner → reliably YES/NO, rarely VOID). The narrow next_corner/next_goal are
    // left to the AI director to open with sharper timing. Alternate the YES side so both
    // teams take turns being the named team.
    const team: Team = this.versusCounter % 2 === 0 ? 'home' : 'away';
    const trigger = buildVersusTrigger(game, team, Math.floor(this.versusCounter / 2));
    if (!trigger) return;

    const beforeOpened = this.metrics.marketsOpened;
    await this.openTriggeredMarket(trigger, {
      slot: 'versus',
      team,
      logLabel: `versus kind=${trigger.kind} team=${team}`,
    });
    if (this.metrics.marketsOpened > beforeOpened) {
      this.lastVersusOpenAt = Date.now();
      this.versusCounter++;
    }
  }

  private async openTriggeredMarket(
    trigger: MarketTrigger,
    opts: {
      sequenceId?: string;
      team?: Team;
      slot?: MarketSlot;
      isPeriod?: boolean;
      openClockMin?: number;
      openerType?: FeedEvent['type'];
      playerId?: string;
      logLabel: string;
    },
  ): Promise<void> {
    const slot = opts.slot ?? trigger.slot ?? marketSlot(trigger.kind);
    if (this.hasBlockingMarket(slot)) return;

    // FLOW PACING: this market is committing to the board — stamp the release time so the
    // paced (momentum/player) openers hold off for MIN_OPEN_SPACING_MS and nothing lands
    // right on top of it. (Set-pieces reach here un-gated but still stamp, so a momentum
    // market won't surface in the same beat as a corner.)
    this.lastOpenReleaseAt = Date.now();

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

    // House-liquidity bots for the POINTS pool — random two-sided money leaning to the
    // undervalued side so the points multiple actually MOVES (not pinned near ~1.1x).
    const pointsBots = new PointsBotSwarm(
      this.server.pointsManager,
      (fx) => this.server.emitPoints(fx),
      resolveBotConfig({
        count: this.config.pointsBotCount,
        minStake: this.config.pointsBotMinStake,
        maxStake: this.config.pointsBotMaxStake,
      }),
    );
    pointsBots.start(market);

    const lockTimer = setTimeout(() => this.lockMarket(market.id), armed.windowMs);

    this.tracked.set(market.id, {
      marketId: market.id,
      sequenceId: opts.sequenceId,
      team: opts.team,
      bots,
      pointsBots,
      lockTimer,
      resolveWindowMs: deadline,
      pending: new Map(),
      marketSeed,
      slot,
      openSeq: this.eventCounter,
      // Always stamp the match-clock minute at open — the anti-arb match-clock fallback (for a
      // goal that arrives without an exact wallclock) needs it on EVERY market, not just the
      // event-opened ones. Falls back to the live game clock when the opener didn't supply one.
      openClockMin: opts.openClockMin ?? this.currentClockMin(),
      ...(opts.openerType ? { openerType: opts.openerType } : {}),
      ...(opts.playerId ? { playerId: opts.playerId } : {}),
      ...(opts.isPeriod ? { isPeriod: true } : {}),
      // OVER/UNDER count markets start a running counter at open (count = 0).
      ...(isCountKind(trigger.kind)
        ? {
            counter: {
              countTypes: countEventTypes(trigger.kind),
              line: countLine(trigger.kind),
              count: 0,
            },
          }
        : {}),
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
    t.pointsBots.cancel();
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
    // During a hydration/cooling break there's no play — don't let markets time out to
    // NO. Their deadlines simply wait; the NO sweep resumes when the break ends.
    if (this.breakPaused) return;
    for (const t of [...this.tracked.values()]) {
      if (t.isPeriod) continue; // period markets settle on their own goal / FT
      const m = this.engine.get(t.marketId);
      if (!m || m.status !== 'locked') continue;
      if (now < m.resolveAt) continue;

      // LAG-AWARE NO HOLD: when the feed is lagging MORE than the deadlines assume, a real
      // in-window goal can still be in flight — wait out the excess lag (capped) before
      // settling a goal-question market NO, so we never NO a goal that already happened.
      if (anyTeamGoalCountsYes(m.kind)) {
        const lagMs = (this.lagMeter.wallclockLagSec() ?? 0) * 1000;
        const extra = Math.min(Math.max(0, lagMs - EXPECTED_FEED_LAG_MS), MAX_LATE_GOAL_GRACE_MS);
        if (extra > 0 && now < m.resolveAt + extra) continue;
      }

      if (isSetPieceGoalKind(m.kind) && !t.setPieceTakenAt) {
        const maxUnconfirmedAt = m.lockAt + SET_PIECE_MAX_UNCONFIRMED_MS;
        if (now < maxUnconfirmedAt) {
          this.extendMarketResolve(t, Math.min(now + SET_PIECE_UNTAKEN_GRACE_MS, maxUnconfirmedAt));
          continue;
        }
        console.log(`[golazo/feed] market_deadline_no_unconfirmed_set_piece id=${m.id} kind=${m.kind}`);
      }

      // Late-goal rescue: for kinds where ANY goal by the team in-window counts
      // (momentum / open-play / extra-time), if a goal was recorded at/after the
      // market opened, settle YES instead of NO. Strict set-piece kinds require
      // attributed evidence (handled at the goal event), so they always NO here.
      if (
        anyTeamGoalCountsYes(m.kind) &&
        goalAlreadyHappenedForChance(t.team, t.openClockMin, this.lastResolverByTeam) &&
        this.rescueGoalIsClean(t, m)
      ) {
        console.log(
          `[golazo/feed] market_deadline_late_goal id=${m.id} kind=${m.kind} team=${t.team ?? 'n/a'}`,
        );
        this.finalizeMarket(t, 'YES');
        continue;
      }

      // Teamless "a goal in the next few minutes? (either team)" rescue: a goal by EITHER team
      // recorded at/after open settles YES (the team-based rescue above can't fire for it). MUST
      // be taint-gated by rescueGoalIsClean exactly like the team-based rescue — else a goal that
      // happened DURING betting (which the immediate path correctly skipped) would arb back in
      // here at the deadline with no taint check.
      if (
        m.kind === 'goal_in_window' &&
        !t.team &&
        this.anyTeamGoalAfterOpen(t) &&
        this.rescueGoalIsClean(t, m)
      ) {
        console.log(`[golazo/feed] market_deadline_late_goal id=${m.id} kind=${m.kind} team=either`);
        this.finalizeMarket(t, 'YES');
        continue;
      }

      // WHICH-SIDE-NEXT with no decisive event by the deadline → VOID/refund (the contest
      // never happened), never NO — fair and arb-clean.
      if (isWhichSideNextKind(m.kind)) {
        console.log(`[golazo/feed] which_side_next_deadline void id=${m.id} kind=${m.kind}`);
        this.finalizeMarket(t, 'VOID', { voidCause: 'which_side_next_deadline' });
        continue;
      }

      console.log(`[golazo/feed] market_deadline_no id=${m.id} kind=${m.kind}`);
      this.finalizeMarket(t, 'NO');
    }
  }

  private markSetPieceTaken(target: TrackedMarket, m: Market): void {
    if (!isSetPieceGoalKind(m.kind) || target.setPieceTakenAt) return;
    target.setPieceTakenAt = Date.now();
    this.extendMarketResolve(target, Date.now() + SET_PIECE_AFTER_TAKEN_GRACE_MS);
  }

  private extendMarketResolve(target: TrackedMarket, resolveAt: number): void {
    const m = this.engine.extendResolve(target.marketId, resolveAt);
    console.log(
      `[golazo/feed] market_deadline_extend id=${m.id} kind=${m.kind} to=${Math.round(resolveAt - Date.now())}ms`,
    );
  }

  /**
   * The TRUE wall-clock time an event happened, in ms — ONLY when we know it exactly (the
   * ESPN keyEvent wallclock, carried by goals/cards/penalties). We deliberately do NOT
   * estimate a commentary event's time from the measured feed lag: that lag is a sparse,
   * goal-derived snapshot, and a stale/inflated value would wrongly mark a legitimate
   * just-after-close shot as "during betting" and settle a winning market NO — a far worse
   * failure than the small arb edge on a fuzzy commentary event. No exact wallclock →
   * undefined → the caller counts the event (resolverIsTainted returns false).
   */
  private eventWallclockMs(ev: FeedEvent): number | undefined {
    const wc = ev.meta?.wallclock;
    if (typeof wc === 'string') {
      const t = Date.parse(wc);
      if (Number.isFinite(t)) return t;
    }
    return undefined;
  }

  /**
   * ANTI-ARB CORE. True when a resolver event must be IGNORED because it really happened
   * at/before this market's betting closed — a viewer watching the real broadcast (ahead of
   * our ~50s-lagged feed) could have bet on a known outcome. We do NOT void and do NOT touch
   * any bet; the caller simply skips the event, and the market keeps waiting for a CLEAN
   * later event (or times out). The same rule makes resolution consistent across markets:
   * an event is judged by WHEN IT HAPPENED, not when it was reported.
   */
  private resolverIsTainted(ev: FeedEvent, m: Market, t: TrackedMarket): boolean {
    const evWc = this.eventWallclockMs(ev);
    if (evWc !== undefined) {
      // Exact ESPN wallclock — precise taint.
      return evWc < bettingClosesAt(m.lockAt, m.windowMs) - RESOLVER_SKEW_GRACE_MS;
    }
    // No exact wallclock. A GOAL is the high-value decisive resolver and must still be
    // taint-checked — fall back to the MATCH CLOCK: a goal whose game-minute is at/before the
    // minute the market opened could have been seen on TV during betting, so treat it as
    // tainted (arb-safe). This only fires for the rare goal ESPN reports without a wallclock.
    // Commentary (shots/corners/attacks) fails OPEN (counted) — the arb edge there is small and
    // a coarse-clock taint would wrongly NO legit markets (the prior blocking over-taint bug).
    // NO exact wallclock → we cannot PROVE the event happened during betting. The match clock
    // is whole-minute granular while the betting window is ~10s, so any match-clock taint
    // over-blocks legitimate in-window goals (a real goal one minute after open is clean but
    // looks "same-ish minute") FAR more often than it catches the rare arb. So we FAIL OPEN:
    // count the event. This leaves a small, irreducible residual — a commentary-first resolver
    // (a goal/penalty ESPN reports without a wallclock) that truly happened during betting can
    // still settle YES. It's bounded (most authoritative resolvers carry a wallclock and use the
    // precise branch above) and only a faster feed can close it; a fuzzy taint here is worse.
    return false;
  }

  /** The current match-clock minute (fractional, e.g. 45+2 → 45.02) from the live game state. */
  private currentClockMin(): number {
    const { base, stopp } = parseClockKey(this.feed.state().clock);
    return base + stopp / 100;
  }

  /**
   * Anti-arb gate for the late-goal RESCUE: only rescue a goal-question market to YES if the
   * goal that triggers it really happened AFTER betting closed (else a TV viewer could have
   * bet on a goal they'd already seen). Mirrors resolverIsTainted, but for the goal recorded
   * earlier rather than the live event. A goal with no timing signal is treated as clean.
   */
  private rescueGoalIsClean(t: TrackedMarket, m: Market): boolean {
    const cutoff = bettingClosesAt(m.lockAt, m.windowMs) - RESOLVER_SKEW_GRACE_MS;
    if (t.team) {
      const wc = this.lastGoalWallclockByTeam.get(t.team);
      // Exact wallclock → precise. No wallclock → clean (fail open, consistent with the
      // immediate path: we can't prove a wallclock-less goal happened during betting, so we
      // don't block a legitimate late goal from rescuing the market to YES).
      return wc === undefined || wc >= cutoff;
    }
    // Teamless rescue doesn't fire (goalAlreadyHappenedForChance requires a team) — be safe.
    for (const wc of this.lastGoalWallclockByTeam.values()) if (wc >= cutoff) return true;
    return false;
  }

  /** True if EITHER team has a recorded goal at/after this market's open clock (teamless rescue). */
  private anyTeamGoalAfterOpen(t: TrackedMarket): boolean {
    if (t.openClockMin === undefined) return false;
    for (const goalMin of this.lastResolverByTeam.values()) {
      if (goalMin >= t.openClockMin) return true;
    }
    return false;
  }

  /** True if ANY team scored within the given window — drives post-goal market suppression. */
  private recentGoalCooloff(ms: number): boolean {
    const now = Date.now();
    for (const t of this.lastGoalAt.values()) if (now - t < ms) return true;
    return false;
  }

  /** Seconds since the most recent goal (any team), or undefined if none yet this match. */
  private secondsSinceLastGoal(): number | undefined {
    let last = 0;
    for (const t of this.lastGoalAt.values()) last = Math.max(last, t);
    return last > 0 ? (Date.now() - last) / 1000 : undefined;
  }

  /**
   * Resolve all markets decided by a feed event. With slots, one goal can settle a
   * moment market, a window market, and a before-whistle period market together.
   */
  private async resolveFromEvent(ev: FeedEvent): Promise<boolean> {
    this.recordResolverClock(ev);

    // TIMING TELEMETRY: log Golazo's true lag at each resolving moment — how far behind
    // the real event-time (ESPN wallclock) we are when we act on it. This is the number
    // that decides whether we sit ahead of or behind a viewer's stream; the presentation
    // buffer is tuned off it. Resolver events only (goals/shots), so it's low-volume.
    const wc = typeof ev.meta?.wallclock === 'string' ? Date.parse(ev.meta.wallclock) : NaN;
    if (!Number.isNaN(wc)) {
      console.log(
        `[golazo/feed] resolver_lag type=${ev.type}${ev.team ? '/' + ev.team : ''} ` +
          `lagSec=${Math.round((Date.now() - wc) / 1000)} clock=${String(ev.meta?.clock ?? '')}`,
      );
    }

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

      // ANTI-ARB: a resolver that really happened at/before betting closed (a TV viewer could
      // have bet on it) is not allowed to settle. For a SINGLE-OUTCOME set-piece market ("will
      // THIS corner/penalty be scored?"), a tainted scoring goal means the one event the market
      // is about already happened during/before betting — the market opened too late on the
      // lagged feed to bet fairly, so VOID/refund (no genuine opportunity) rather than skip-to-NO
      // (which would wrongly settle a real goal NO). For multi-chance window/count/which-side
      // kinds we just skip and wait for a clean later event.
      if (this.resolverIsTainted(ev, m, target)) {
        if (isSetPieceGoalKind(m.kind) && decision.outcome === 'YES') {
          console.log(`[golazo/feed] stale_set_piece_void id=${m.id} kind=${m.kind} type=${ev.type}`);
          this.finalizeMarket(target, 'VOID', { voidCause: 'stale_set_piece' });
          settled = true;
          continue;
        }
        console.log(`[golazo/feed] resolver_tainted_skip id=${m.id} kind=${m.kind} type=${ev.type}`);
        continue;
      }

      // GUARANTEED BETTING WINDOW: an outcome that lands while betting is still OPEN
      // is HELD, not applied — it settles the moment the market locks (see lockMarket).
      // So a market can never open and resolve in the same breath; there is always a
      // real window to bet in. A later YES overrides a held miss/NO; first wins otherwise.
      if (m.status === 'open') {
        const prev = target.pendingOutcome;
        // A later YES overrides a held miss/NO for "will X happen" kinds. But a
        // which-side-next contest is decided by the FIRST decisive event (YES or NO) —
        // a later same-team shot must NOT flip a held "the other team shot first" NO.
        const yesOverrides =
          decision.outcome === 'YES' && prev?.outcome !== 'YES' && !isWhichSideNextKind(m.kind);
        if (!prev || yesOverrides) {
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
      // Record the goal's EXACT wallclock only — never the arrival time (Date.now() on a
      // lagged feed always looks "clean" and would let a during-betting wallclock-less goal
      // pass the rescue). No wallclock → leave it unset; rescueGoalIsClean uses the match clock.
      const gwc = this.eventWallclockMs(ev);
      if (gwc !== undefined) this.lastGoalWallclockByTeam.set(ev.team, gwc);
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

    // WHICH-SIDE-NEXT contests are resolved by the dedicated resolveWhichSideMarkets pass
    // (which runs for EVERY event, including corner/dangerous_attack that never reach here),
    // never via this path — return no opinion so nothing double-handles them.
    if (isWhichSideNextKind(m.kind)) return undefined;

    if (m.kind === 'penalty_awarded') {
      if (ev.type === 'penalty') return { outcome: 'YES' };
      if (ev.type === 'var_penalty_denied') return { outcome: 'NO' };
      return undefined;
    }

    if (m.kind === 'red_card_given') {
      return ev.type === 'red_card' ? { outcome: 'YES' } : undefined;
    }

    if (isSetPieceInvalidation(ev, m.kind)) {
      return {
        outcome: 'VOID',
        voidCause: 'set_piece_invalidated',
        voidReason: ev.text.slice(0, 80),
      };
    }

    if (isSetPieceGoalKind(m.kind)) {
      if (ev.type === 'goal') return { outcome: 'YES' };
      if (ev.type === 'shot' || ev.type === 'miss') {
        this.markSetPieceTaken(target, m);
        return undefined;
      }
      if (ev.type === 'play_end') {
        this.markSetPieceTaken(target, m);
        return { outcome: 'NO' };
      }
      return undefined;
    }

    // A genuine end-of-play (the set piece was CLEARED) settles a goal-question NO
    // fast. A 'miss' (saved/blocked) does NOT — it can REBOUND into a goal that ESPN
    // reports a poll later, so letting a miss settle NO here pre-empts a real YES.
    // Misses now settle only via the deadline sweep + late-goal rescue.
    if (ev.type === 'play_end' && isGoalQuestionKind(m.kind)) {
      return { outcome: 'NO' };
    }

    // Goal attribution for open-play goal-question kinds: ESPN's own goal text decides.
    // Set-pieces are handled above by timing from the awarded kick/corner because ESPN
    // prose can mislabel "following a corner" after a free kick.
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
    if (isSetPieceInvalidation(ev, m.kind)) return true;

    // TEAMLESS "event" lane — either-team questions, matched BEFORE the team guards.
    if (m.kind === 'card_in_window') {
      return ev.type === 'yellow_card' || ev.type === 'red_card' || ev.type === 'card';
    }
    if (m.kind === 'goal_in_window') return ev.type === 'goal';
    // OVER/UNDER count markets are settled by the bumpCountMarkets pass, never here.
    if (isCountKind(m.kind)) return false;
    // WHICH-SIDE-NEXT contests are settled by the dedicated resolveWhichSideMarkets pass,
    // never here — so they're never findMarketsFor targets (no double-handling).
    if (isWhichSideNextKind(m.kind)) return false;

    if (t.team && ev.team && t.team !== ev.team) return false;
    if (ev.team && t.team !== ev.team) return false;
    if (m.kind === 'player_to_score') {
      // Resolves YES only on a goal whose scorer (participants[0]) is THIS player.
      return ev.type === 'goal' && playerIdOf(ev) === t.playerId;
    }
    if (m.kind === 'shot_in_window') return ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss';
    if (m.kind === 'shot_or_corner_in_window') {
      return ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss' || ev.type === 'corner';
    }
    if (m.kind === 'score_in_window') return ev.type === 'goal';
    if (isSetPieceGoalKind(m.kind)) {
      return ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss' || ev.type === 'play_end';
    }
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
    this.lastGoalWallclockByTeam.clear();
    this.lagMeter.reset(); // a prior fixture's feed lag must not carry into the new match
    this.lastMomentumOpenAt.clear();
    // CRITICAL: per-match state that MUST NOT carry into the next match — otherwise a
    // hot player (or momentum) from the previous game keeps opening markets for someone
    // who isn't even on the pitch (the "Hélio Varela in New Zealand vs Egypt" bug).
    this.playerForm.clear();
    this.lastPlayerMarketId = undefined;
    this.lastPlayerMarketAt = 0;
    this.lastGoalAt.clear();
    this.momentum.reset();
    this.lastOpenReleaseAt = 0;
    this.lastEventSlotOpenAt = 0;
    this.lastCountSlotOpenAt = 0;
    this.eventSlotCounter = 0;
    this.countSlotCounter = 0;
    this.lastVersusOpenAt = 0;
    this.versusCounter = 0;
    this.heartbeatSeeded = false;
    this.commentary.clear();
    this.enhancer.resetForMatch(); // drop a prior fixture's pooled lines
    this.director.resetForMatch(); // drop a prior fixture's pooled proposals
    this.breakPaused = false;
    this.breakStartedAt = 0;
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
    t.pointsBots.cancel();
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
    // LATENCY-ARB DEFENSE: a decisive outcome that landed during the open window is HELD
    // (pendingOutcome) and applied at lock — but it is already PUBLIC. Reject any bet placed
    // after it, so a user who saw the shot/threat/crossing can't bet the known winner. A bet
    // placed BEFORE the decider was held normally and is still honored (it took the risk).
    if (t.pendingOutcome) {
      this.rejectHeldBet(msg.marketId, { ...msg }, 'result already decided');
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
    // LATENCY-ARB DEFENSE (same as real money): reject a bet placed after a held decisive
    // outcome — the result is already public, so it can't be bet on.
    if (t.pendingOutcome) {
      this.rejectPointsHeldBet(msg.marketId, { ...msg }, 'result already decided');
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

  /**
   * Remember each team's last GOAL clock — the late-goal rescue (goalAlreadyHappenedForChance
   * + rescueGoalIsClean) reads this to settle a goal-question market YES when a goal landed
   * late. GOALS ONLY: a miss must NEVER be recorded here, or a team that only MISSED after a
   * market opened would wrongly rescue a pure-goal market (score_in_window etc.) to YES.
   */
  private recordResolverClock(ev: FeedEvent): void {
    if (ev.type !== 'goal' || !ev.team) return;
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

/** The ESPN athlete id of an event's primary actor (the scorer on a goal). */
function playerIdOf(ev: FeedEvent): string | undefined {
  const p = ev.meta?.player as { id?: string } | undefined;
  return p?.id;
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
  return (
    isPlayMarketKind(kind) ||
    kind === 'shot_in_window' ||
    kind === 'shot_or_corner_in_window' ||
    kind === 'score_in_window'
  );
}

function isSetPieceGoalKind(kind: string | undefined): boolean {
  return kind === 'goal_from_corner' || kind === 'goal_from_free_kick' || kind === 'penalty_scored';
}

function isSetPieceInvalidation(ev: FeedEvent, kind: string | undefined): boolean {
  if (ev.type !== 'var_penalty_denied' || !isSetPieceGoalKind(kind)) return false;
  const t = ev.text.toLowerCase();
  if (kind === 'goal_from_corner') {
    return /\b(no corner|not a corner|corner (?:overturned|cancelled|rescinded)|goal kick after (?:a )?var)\b/.test(
      t,
    );
  }
  if (kind === 'goal_from_free_kick') {
    return /\b(no free[- ]?kick|not a free[- ]?kick|free[- ]?kick (?:overturned|cancelled|rescinded))\b/.test(
      t,
    );
  }
  if (kind === 'penalty_scored') {
    return /\b(no penalty|not a penalty|penalty (?:overturned|cancelled|rescinded|denied))\b/.test(
      t,
    );
  }
  return false;
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
    // "a SHOT or CORNER this spell?" — same late-goal rescue (a goal is a shot attempt).
    kind === 'shot_or_corner_in_window' ||
    kind === 'chance_from_play' ||
    kind === 'goal_from_open_play' ||
    kind === 'goal_in_stoppage' ||
    kind === 'goal_in_extra_time' ||
    // Teamless "a goal in the next few minutes? (either team)" — must get the LAG-AWARE NO HOLD
    // too, else a real goal reported a poll or two past its deadline settles a permanent NO
    // (the user's "a goal happened but it resolved NO" bug for the heartbeat goal market).
    kind === 'goal_in_window'
  );
}

const PLAYER_QUESTIONS = [
  (name: string) => `${name} — to SCORE in the next few minutes?`,
  (name: string) => `Will ${name} score soon?`,
  (name: string) => `${name} is hot — GOAL incoming?`,
  (name: string) => `Can ${name} find the net?`,
] as const;

function pickPlayerQuestion(name: string, seed: number): string {
  return PLAYER_QUESTIONS[Math.abs(seed) % PLAYER_QUESTIONS.length]!(name);
}
