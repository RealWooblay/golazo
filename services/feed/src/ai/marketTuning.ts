// ───────────────────────────────────────────────────────────────────────────
// MARKET TUNING — the ONE place that decides what becomes a market, when, for
// how long, and how sure we must be. Everything market-shaped (the ESPN
// classifier, the AI watcher, the orchestrator's timers) reads from here, so
// tuning the product is editing this file and nothing else.
// ───────────────────────────────────────────────────────────────────────────
import type {
  FeedEvent,
  FeedEventType,
  GameState,
  MarketSlot,
  MarketTrigger,
  Team,
} from '@golazo/core';
import { parseClockKey } from '../feed/espn';

export type MarketTier = 'set_piece';
export type OpenableType = 'penalty' | 'corner' | 'free_kick' | 'var_check';

/** Everything we know about ONE kind of bettable moment. */
export interface MarketTypeKnob {
  /** set_piece → rules open it instantly (inherently a chance). No AI gating. */
  tier: MarketTier;
  /** How long betting stays OPEN before the market locks (must close before the play resolves). */
  betWindowMs: number;
  /** After lock, how long to wait for a goal/miss before settling the goal-question NO. */
  resolveWindowMs: number;
}

/**
 * Per-type knobs. To make a moment more/less bettable, or change its window,
 * edit the numbers here — nothing else. All openable moments are now rule-driven
 * set-pieces (the fuzzy AI-judged open-play path was deleted; its volume is now
 * the momentum time-boxed markets opened in the orchestrator).
 *
 * resolveWindowMs must cover ESPN's reporting delay (often 30–60s on the free
 * feed). Too short → a real goal lands after we've already settled NO.
 */
export const MARKET_TYPES: Record<OpenableType, MarketTypeKnob> = {
  // Set pieces are FAST-REACTION markets: the short 5s betting window is deliberate — it
  // closes quickly so a bettor can't watch the kick develop and bet the known outcome.
  // (12s let the play resolve inside the window → gameable.)
  penalty: { tier: 'set_piece', betWindowMs: 5_000, resolveWindowMs: 50_000 },
  corner: { tier: 'set_piece', betWindowMs: 5_000, resolveWindowMs: 90_000 },
  // A free kick is a set piece like any other — if one is awarded and the slot is
  // free, open a market. The only free kick we DON'T open is a clearly defensive /
  // own-half one (filtered in the watcher); everything else just opens, no AI needed.
  free_kick: { tier: 'set_piece', betWindowMs: 5_000, resolveWindowMs: 90_000 },
  // VAR reviews take real time (often 60–120s + feed lag) — a short window made
  // card/penalty markets settle NO before the decision was even reported. Wait it out.
  var_check: { tier: 'set_piece', betWindowMs: 8_000, resolveWindowMs: 120_000 },
};

export function knobFor(type: FeedEvent['type']): MarketTypeKnob | undefined {
  return (MARKET_TYPES as Record<string, MarketTypeKnob>)[type];
}

export function tierOf(type: FeedEvent['type']): MarketTier | 'ignore' {
  return knobFor(type)?.tier ?? 'ignore';
}

/** Match-clock of an event in fractional minutes (e.g. 45+2 → 45.02). */
export function clockMinutes(ev: FeedEvent): number | undefined {
  const raw = ev.meta?.clock;
  if (typeof raw !== 'string') return undefined;
  const c = parseClockKey(raw);
  return c.base + c.stopp / 100;
}

/** How far behind the live scoreboard clock this event's stamp is (minutes). */
export function feedLagMinutes(ev: FeedEvent, game: GameState): number {
  const evMin = clockMinutes(ev);
  if (evMin === undefined) return 0;
  const liveC = parseClockKey(game.clock);
  const liveMin = liveC.base + liveC.stopp / 100;
  return Math.max(0, liveMin - evMin);
}

/**
 * Ms before lockAt when we stop taking bets. Capped so it never eats the whole window
 * (5s buffer on a 7s window was leaving ~1s to bet — the "1 second markets" bug).
 */
export const BET_SAFETY_BUFFER_MS = 2000;

/** Buffer scales down for shorter windows; never more than 25% of the betting window. */
export function bettingSafetyBufferMs(windowMs: number): number {
  return Math.min(BET_SAFETY_BUFFER_MS, Math.max(800, Math.floor(windowMs * 0.2)));
}

/** Wall-clock instant after which new bets are rejected (still open until lockAt). */
export function bettingClosesAt(lockAt: number, windowMs = 10_000): number {
  return lockAt - bettingSafetyBufferMs(windowMs);
}

/** Max feed lag we'll still open a market for — set-pieces must be timely. */
export function staleLagThreshold(type: FeedEvent['type']): number {
  const k = knobFor(type);
  if (!k) return 1.25;
  // 0.75min (was 0.5) — on the ~2-min-lagged ESPN feed an event's match-clock stamp
  // legitimately trails the live scoreboard clock, so 30s was rejecting genuinely
  // fresh corners/free kicks as "stale". The wallclock gate is the real backstop.
  return 0.75;
}

/** True when a moment is too far behind live play to open fairly. */
export function isStalePlay(ev: FeedEvent, game: GameState): boolean {
  return feedLagMinutes(ev, game) > staleLagThreshold(ev.type);
}

/**
 * Before timing out a goal-question to NO, check if ESPN already reported a goal
 * for this team at/after the chance opened (common when the goal event lands in
 * a later poll than the attack opener).
 */
export function goalAlreadyHappenedForChance(
  marketTeam: Team | undefined,
  openClockMin: number | undefined,
  lastResolverByTeam: ReadonlyMap<Team, number>,
): boolean {
  if (!marketTeam || openClockMin === undefined) return false;
  const last = lastResolverByTeam.get(marketTeam);
  // Strictly at/after the open — the old 0.5-min look-back let a goal that happened
  // BEFORE the market opened rescue it to a false YES (the clock barely advances on
  // the ~2-min feed). A goal at the open clock still rescues; a pre-open one doesn't.
  return last !== undefined && last >= openClockMin;
}

/** Stretch the post-lock resolve window in tense late-game moments. */
export function scaledResolveWindowMs(type: FeedEvent['type'], game: GameState): number {
  const knob = knobFor(type);
  if (!knob) return 10_000;
  const ctx = parseGameContext(game);
  let f = 1;
  if (ctx.isExtraTime) f *= 1.15;
  if (ctx.isStoppage) f *= 1.15;
  if (ctx.isClose && (ctx.minutesLeft <= 10 || ctx.isStoppage)) f *= 1.1;
  return Math.round(knob.resolveWindowMs * f);
}

/** Extra time added when subs/injury/VAR delay the match. */
export const STOPPAGE_EXTEND_MS = 90_000;

/**
 * MOMENTUM VOLUME KNOB — minimum leader intensity to open a momentum time-boxed
 * market. This is now a KEEP-ALIVE threshold: with the per-tick heartbeat opener +
 * the 0.98 per-tick decay, a low floor lets a market open whenever ANY decayed leader
 * still exists, which is what lifts the board from ~43% to ~85% of the match VISIBLE
 * (measured). It is deliberately low because momentum sits below 1.6 for ~86% of live
 * time; a higher floor leaves the board dead most of the match. Phrasing stays honest
 * because the "siege/all over them" lines only fire at MOMENTUM_GOAL_THRESHOLD (5.0) —
 * a low-intensity open gets the milder "a shot this spell?" wording.
 */
export const MOMENTUM_OPEN_THRESHOLD = 0.15;

/**
 * OVER/UNDER COUNT markets ("more than N corners/shots in the next few minutes?").
 * The market counts qualifying events since it opened and settles YES the moment the
 * running count crosses the line; if the line is never crossed it settles NO at the
 * deadline. The deadline = the counting WINDOW + feed lag, so a qualifying event that
 * ESPN reports a poll late still lands inside the window.
 */
export const COUNT_WINDOW_MS = 240_000; // 4-minute counting window
export const COUNT_LAG_MS = 60_000; // + ~55–60s feed lag before NO

/** Bet window for heartbeat-opened event/count/versus markets. */
export const HEARTBEAT_BET_WINDOW_MS = 8_000;

function pickRotated<T>(variants: readonly T[], seed: number): T {
  return variants[Math.abs(seed) % variants.length]!;
}

const CARD_WINDOW_QUESTIONS: ((mins: number) => string)[] = [
  (mins) => `A booking in ${mins} min?`,
  (mins) => `Any card in ${mins} min?`,
  (mins) => `A yellow in the next ${mins} min?`,
  (mins) => `Card shown in ${mins} min?`,
];

const GOAL_WINDOW_QUESTIONS: ((mins: number) => string)[] = [
  (mins) => `Any goal in ${mins} min?`,
  (mins) => `Either team to score in ${mins} min?`,
  (mins) => `A goal in the next ${mins} min?`,
  (mins) => `Goal for either team in ${mins} min?`,
];

/** Rotating event-slot heartbeat — card vs goal, varied copy each cycle. */
export function buildEventSlotTrigger(gameId: string, counter: number): MarketTrigger {
  const isCard = counter % 2 === 0;
  if (isCard) {
    const mins = Math.max(1, Math.round(resolveDeadlineMs('card_in_window') / 60_000));
    return {
      gameId,
      question: pickRotated(CARD_WINDOW_QUESTIONS, counter)(mins),
      kind: 'card_in_window',
      slot: 'event',
      windowMs: HEARTBEAT_BET_WINDOW_MS,
      trueProb: 0.35,
    };
  }
  const mins = Math.max(1, Math.round(resolveDeadlineMs('goal_in_window') / 60_000));
  return {
    gameId,
    question: pickRotated(GOAL_WINDOW_QUESTIONS, counter)(mins),
    kind: 'goal_in_window',
    slot: 'event',
    windowMs: HEARTBEAT_BET_WINDOW_MS,
    trueProb: 0.3,
  };
}

// `mins` = the real counting window (COUNT_WINDOW_MS) so the title states the exact window
// it settles on. Count markets are TEAM-AGNOSTIC (either team's corners/shots count).
const CORNER_COUNT_QUESTIONS: ((line: number, mins: number) => string)[] = [
  (line, mins) => `Over ${line} corners in ${mins} min?`,
  (line, mins) => `${line + 1}+ corners in ${mins} min?`,
  (line, mins) => `More than ${line} corners in ${mins} min?`,
  (line, mins) => `${line + 1}+ corners in ${mins} min?`,
];

const SHOT_COUNT_QUESTIONS: ((line: number, mins: number) => string)[] = [
  (line, mins) => `Over ${line} shots in ${mins} min?`,
  (line, mins) => `${line + 1}+ shots in ${mins} min?`,
  (line, mins) => `More than ${line} shots in ${mins} min?`,
  (line, mins) => `${line + 1}+ shots in ${mins} min?`,
];

/** Rotating count-slot heartbeat — corners vs shots, varied copy. */
export function buildCountSlotTrigger(gameId: string, counter: number): MarketTrigger {
  const isCorners = counter % 2 === 0;
  const kind = isCorners ? 'over_corners' : 'over_shots';
  const line = countLine(kind);
  // State the FULL window the market settles on (its resolve deadline) so the title's
  // "in N min" matches the card's RESOLVES-IN timer exactly — events count until then.
  const mins = Math.max(1, Math.round(resolveDeadlineMs(kind) / 60_000));
  const q = isCorners
    ? pickRotated(CORNER_COUNT_QUESTIONS, counter)(line, mins)
    : pickRotated(SHOT_COUNT_QUESTIONS, counter)(line, mins);
  return {
    gameId,
    question: q,
    kind,
    slot: 'count',
    windowMs: HEARTBEAT_BET_WINDOW_MS,
    trueProb: 0.45,
  };
}

type VersusPhrase = (a: string, b: string) => string;

const NEXT_SHOT_PHRASES: readonly VersusPhrase[] = [
  (a, b) => `Next shot: ${a} or ${b}?`,
  (a, b) => `Who shoots next: ${a} or ${b}?`,
  (a, b) => `Next team to shoot: ${a} or ${b}?`,
];
const NEXT_CORNER_PHRASES: readonly VersusPhrase[] = [
  (a, b) => `Next corner: ${a} or ${b}?`,
  (a, b) => `Next corner won by: ${a} or ${b}?`,
];
const NEXT_GOAL_PHRASES: readonly VersusPhrase[] = [
  (a, b) => `Next goal: ${a} or ${b}?`,
  (a, b) => `Next scorer: ${a} or ${b}?`,
];
const NEXT_CARD_PHRASES: readonly VersusPhrase[] = [
  (a, b) => `Next booking: ${a} or ${b}?`,
  (a, b) => `Next card: ${a} or ${b}?`,
];

/** The which-side-next CONTESTS the heartbeat rotates through — kind + phrasing bank. */
const VERSUS_CONTESTS = [
  { kind: 'next_shot', bank: NEXT_SHOT_PHRASES },
  { kind: 'next_corner', bank: NEXT_CORNER_PHRASES },
  { kind: 'next_goal', bank: NEXT_GOAL_PHRASES },
  { kind: 'next_card', bank: NEXT_CARD_PHRASES },
] as const;

/** Rotating which-side-next contest — shot / corner / goal / card, varied phrasing each cycle. */
export function buildVersusTrigger(
  game: GameState,
  team: Team,
  variant: number,
): MarketTrigger | null {
  const teamName = team === 'home' ? game.home.name : game.away.name;
  const otherName = team === 'home' ? game.away.name : game.home.name;
  if (!teamName || !otherName) return null;
  const contest = VERSUS_CONTESTS[Math.abs(variant) % VERSUS_CONTESTS.length]!;
  const phrase = pickRotated(contest.bank, Math.floor(Math.abs(variant) / VERSUS_CONTESTS.length));
  return {
    gameId: game.gameId,
    question: phrase(teamName, otherName),
    kind: contest.kind,
    slot: 'versus',
    team,
    windowMs: HEARTBEAT_BET_WINDOW_MS,
    trueProb: 0.5,
  };
}

/** The over/under line (count must EXCEED this) for each count kind. */
export function countLine(kind: string): number {
  if (kind === 'over_corners') return 1; // "more than 1 corner" → 2+ corners
  if (kind === 'over_shots') return 2; // "more than 2 shots" → 3+ shots
  return 0;
}

/** Feed event types that increment a given count kind's running counter. */
export function countEventTypes(kind: string): ReadonlySet<FeedEventType> {
  if (kind === 'over_corners') return new Set<FeedEventType>(['corner']);
  if (kind === 'over_shots') return new Set<FeedEventType>(['shot', 'miss', 'goal']);
  return new Set<FeedEventType>();
}

/** True for the over/under COUNT kinds (settled by a running event counter, not a single YES). */
export function isCountKind(kind: string): boolean {
  return kind === 'over_corners' || kind === 'over_shots';
}

/**
 * WHICH-SIDE-NEXT markets ("next shot/corner/goal — which team?"). Unlike "will X happen"
 * kinds, these resolve on a DECISIVE event by EITHER team: the market's team doing it first
 * → YES, the OTHER team doing it first → NO (a scoped, audited event-NO; see the
 * orchestrator's decisiveOutcomeFor). Neither team by the deadline → VOID/refund. This is
 * the ONLY family whose NO can come from an event rather than the deadline sweep.
 */
export function isWhichSideNextKind(kind: string): boolean {
  return (
    kind === 'next_shot' ||
    kind === 'next_corner' ||
    kind === 'next_goal' ||
    kind === 'next_card'
  );
}

/**
 * Guard that a market's QUESTION matches its KIND's resolution model. The client derives the
 * countdown label from the kind: period/stoppage kinds show "until full-time/half-time" (they
 * settle on the whistle), everything else shows a numeric timer (it settles on a deadline). So
 * a NON-period kind worded with a period boundary ("before full-time", "final whistle", "in
 * stoppage") is a lie — it reads like it settles at the whistle but actually runs on a timer.
 * That mismatch is the "verbage is messed up" bug. Returns a problem string, or null if the
 * wording is consistent. Conservative: only flags the clear period/whistle contradiction, so
 * legitimate phrasing is never flagged.
 */
export function triggerWordingProblem(kind: string, question: string, isPeriod = false): string | null {
  const q = question.toLowerCase();
  const periodWorded =
    /final whistle|to the whistle|beat the whistle|before (?:the )?full[- ]?time|before (?:the )?half[- ]?time|before the whistle|before the break|final sprint|final dash|dying (?:minutes|seconds|embers)|last kick|in stoppage|added time|in extra[- ]?time|\bin et\b|equali[sz]er in et/.test(
      q,
    );
  const isPeriodKind = isPeriod || kind === 'goal_in_stoppage' || kind === 'goal_in_extra_time';
  if (periodWorded && !isPeriodKind) {
    return `period/whistle wording on non-period kind '${kind}': "${question}"`;
  }
  // SET-PIECE framing ("before/while/during the free kick / corner / penalty") promises a
  // resolution tied to a set piece — but a timer-settled kind has no such event, so it's a lie
  // (fixes "Will X get a shot away before the free kick ends?" on a shot_in_window market, and
  // a free-kick market opening with no actual free kick). Only the dedicated set-piece kinds
  // may use it.
  const setPieceWorded =
    /(?:before|while|during) (?:the |a |this )?(?:free[- ]?kick|corner|penalty|spot[- ]?kick|set[- ]?piece)\b/.test(
      q,
    );
  const isSetPieceKind =
    kind === 'goal_from_corner' ||
    kind === 'goal_from_free_kick' ||
    kind === 'penalty_scored' ||
    kind === 'penalty_awarded';
  if (setPieceWorded && !isSetPieceKind) {
    return `set-piece wording on non-set-piece kind '${kind}': "${question}"`;
  }
  return null;
}

/** Feed event types that DECIDE a which-side-next market (whichever team does it first). */
export function decisiveEventTypes(kind: string): ReadonlySet<FeedEventType> {
  // next_shot resolves on an ACTUAL shot ONLY — a shot/miss/goal by either side. It must NOT
  // settle on a corner or a fuzzy "dangerous attack": the card says "Next shot", so deciding it
  // off a non-shot (a side that never shot) is a wrong, real-money resolution — and it directly
  // contradicted the companion shot-window market. If no real shot lands before the whistle the
  // contest VOIDs/refunds (fair). Strict = the wording is honest.
  if (kind === 'next_shot')
    return new Set<FeedEventType>(['shot', 'miss', 'goal']);
  if (kind === 'next_corner') return new Set<FeedEventType>(['corner']);
  if (kind === 'next_goal') return new Set<FeedEventType>(['goal']);
  // next_card — whichever team's player is booked next (any card by either side decides it).
  if (kind === 'next_card') return new Set<FeedEventType>(['yellow_card', 'red_card', 'card']);
  return new Set<FeedEventType>();
}

/**
 * Parallel momentum "window" lanes. The board is BETTABLE only during a market's short
 * window (then locked 90–120s while it resolves), so a single lane can't keep something
 * bettable — two lanes (one per team, naturally) roughly double bettable coverage and
 * keep ~2 markets visible. Bounded so the board never spams.
 */
export const MOMENTUM_WINDOW_LANES = 2;

/**
 * Max concurrent momentum markets ONE team may hold. MUST be 1: the opener only ever
 * fires for the single current leader, so a higher cap would let the SAME team stack
 * duplicate same-question markets that resolve in lockstep off one shot. Cap=1 makes
 * each lane genuinely per-team (home gets one, away gets one).
 */
export const MOMENTUM_PER_TEAM_CAP = 1;

/**
 * Post-lock "score window" — how long the user waits for YES evidence once betting
 * closes. Soccer-realistic: set-pieces need wall/setup time; pressing spells run
 * 1–2 minutes; VAR reviews take minutes. Shown on the card as a locked countdown.
 */
export function resolveDeadlineMs(kind: string): number {
  switch (kind) {
    case 'penalty_scored':
      return 50_000; // run-up + kick + ESPN lag
    case 'goal_from_corner':
      return 60_000; // 1 min: deliver + scramble; a goal off it is reported well inside this
    case 'goal_from_free_kick':
      return 60_000; // 1 min: wall, routine or direct shot
    case 'goal_from_open_play':
      return 120_000; // sustained press — up to ~2 match minutes
    case 'chance_from_play':
      // "Will THIS move produce a shot?" — a move is short. Cap at 30s so it
      // never drags; in practice it resolves earlier when the move ends (shot →
      // YES, possession lost / phase ends → NO) via the play-phase + AI resolvers.
      return 30_000;
    case 'penalty_awarded':
    case 'red_card_given':
      return 120_000; // VAR review
    case 'shot_in_window':
      // Momentum time-box: "a shot this spell?" — a short pressing window.
      return 90_000;
    case 'score_in_window':
      // Momentum time-box: "to score in the next N minutes?" — a longer window.
      // Trimmed 180s→120s so one score market can't monopolise the window slot for
      // 3 minutes (more momentum-market throughput).
      return 120_000;
    case 'player_to_score':
      // "Will <player> score in the next few minutes?" — a player goal is rare, so give it a
      // long, forgiving window (5 min) rather than expecting it in the next ~2.5.
      return 300_000;
    case 'shot_or_corner_in_window':
      // Broader momentum window — "a SHOT or CORNER this spell?" resolves YES often.
      return 90_000;
    case 'card_in_window':
      // "A booking in the next few minutes?" — bookings are sporadic; ~3 min + lag.
      return 180_000;
    case 'goal_in_window':
      // "A goal in the next few minutes? (either team)" — a longer, BALANCED window.
      return 300_000;
    case 'over_corners':
    case 'over_shots':
      // Over/under count — the counting window + feed lag (YES on crossing, else NO).
      return COUNT_WINDOW_MS + COUNT_LAG_MS;
    case 'next_shot':
      // "Next shot — which team?" — give a shot time to land before VOID; shots are
      // frequent enough that this usually resolves YES/NO within the window.
      return 150_000;
    case 'next_corner':
      return 210_000;
    case 'next_goal':
      // "Next goal — which team?" — a long contest; goals are rare so it often VOIDs,
      // which is why it's NOT auto-opened on the heartbeat (kept for the AI director).
      return 480_000;
    case 'next_card':
      // "Next booking — which team?" — cards land every few minutes somewhere; a generous
      // window catches one and resolves YES/NO, else VOID/refund.
      return 300_000;
    case 'goal_in_stoppage':
      return STOPPAGE_EXTEND_MS;
    case 'goal_in_extra_time':
      return 25 * 60_000;
    default:
      return 75_000;
  }
}

/**
 * Set-pieces we only open from structured ESPN keyEvents — never commentary prose.
 * Penalties stay keyEvent-only (commentary "penalty area…" false-positives); corners
 * now open from ESPN's canonical "Corner, <Team>." commentary too, since the FIFA
 * feed often narrates a corner before (or without) a structured keyEvent.
 */
export const KEY_EVENT_ONLY_OPENERS = new Set<FeedEvent['type']>(['penalty']);

/**
 * Exactly one open market per slot lane (see `marketSlot`). Momentum allows two
 * concurrent window lanes (one per team). Set-pieces use the `moment` slot.
 */
export function marketSlot(kind: string): MarketSlot {
  if (
    kind === 'shot_in_window' ||
    kind === 'score_in_window' ||
    kind === 'shot_or_corner_in_window'
  ) {
    return 'window';
  }
  if (kind === 'goal_in_stoppage' || kind === 'goal_in_extra_time') return 'period';
  if (kind === 'player_to_score') return 'player';
  // PHASE 2 — teamless "event" lane (a booking / a goal in the next few minutes) and
  // the over/under "count" lane (more than N corners / shots). Each single-occupancy.
  if (kind === 'card_in_window' || kind === 'goal_in_window') return 'event';
  if (kind === 'over_corners' || kind === 'over_shots') return 'count';
  // WHICH-SIDE-NEXT contest lane (next shot/corner/goal — which team?).
  if (kind === 'next_shot' || kind === 'next_corner' || kind === 'next_goal' || kind === 'next_card')
    return 'versus';
  return 'moment';
}

/** True for instant rule-based open: structured ESPN keyEvent set-pieces. */
export function isStructuredSetPiece(ev: FeedEvent): boolean {
  return ev.meta?.source === 'espn.keyEvent' && KEY_EVENT_ONLY_OPENERS.has(ev.type);
}

/**
 * ESPN's canonical "X wins a free kick in the attacking half" line — bettable
 * BEFORE the kick, unlike bare "Foul by Y" commentary.
 */
/** Attacking-half / final-third location language (EN + ES). */
const ATTACKING_LOCATION =
  /\b(attacking|final|opposition'?s?)\s+(half|third)\b|\b(right|left)\s+wing\b|\bout wide\b|\bwide on the (right|left)\b|\bon the (right|left) flank\b|\bbyline\b|campo contrario|zona ofensiva|área ofensiva|area ofensiva|banda (izquierda|derecha)/;

/**
 * Defensive / own-half set-piece language — these are NEVER goal-chance markets
 * (e.g. "Paraguay wins a free kick in their own half" / a FK in their keeper's box).
 */
export function isDefensiveSetPiece(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(defensive|defending|own)\s+(half|third|area|box|penalty area)\b/.test(t)) return true;
  if (/\bin (?:their|his) own\b/.test(t)) return true;
  if (/zona defensiva|campo propio|área defensiva|area defensiva|su (?:propia )?área/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Bettable BEFORE the kick — but ONLY with POSITIVE attacking-location evidence.
 * A bare "wins a free kick" with no location, or a structured keyEvent without an
 * attacking zone, is NOT auto-opened: it falls through to the AI judge (which reads
 * the commentary for location) instead of blindly opening a possibly-defensive FK.
 */
export function isAwardedFreeKick(ev: FeedEvent): boolean {
  if (ev.type !== 'free_kick') return false;
  const t = ev.text.toLowerCase();
  if (isDefensiveSetPiece(t)) return false;

  // English ESPN award line: "X wins a free kick in the attacking half".
  if (/\bwins a free kick\b/.test(t)) return ATTACKING_LOCATION.test(t);
  // Spanish: "X ha recibido una falta en campo contrario / zona ofensiva / banda".
  if (/\bha recibido una falta\b/.test(t)) {
    return ATTACKING_LOCATION.test(t) || /banda (izquierda|derecha)/.test(t);
  }
  // Structured keyEvent FK: only instant-open when it positively names an attacking zone.
  if (ev.meta?.source === 'espn.keyEvent') return ATTACKING_LOCATION.test(t);
  return false;
}

/** Goal-scoring set-pieces outrank card/VAR markets when both arrive together. */
export function openerPriority(type: FeedEvent['type']): number {
  switch (type) {
    case 'corner':
    case 'penalty':
    case 'free_kick':
      return 0;
    case 'var_check':
      return 2;
    default:
      return 9;
  }
}

export function isGoalMomentKind(kind: string): boolean {
  return kind.startsWith('goal_from') || kind === 'penalty_scored';
}

/** Commentary that describes a shot ALREADY taken — never open a market on this. */
export function isPostShotCommentary(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^goal[!]/.test(t)) return true;
  if (/^attempt\s+(saved|blocked|missed|wide|over)/.test(t)) return true;
  // Spanish ESPN: "Remate parado/fallado/bloqueado…"
  if (/^remate\s+(parado|fallado|bloqueado|desviado|fuera)/.test(t)) return true;
  if (/^¡?goooo*ol!/.test(t)) return true;
  if (/\bforces\s+a\s+save\b/.test(t)) return true;
  if (/\boff\s+the\s+(post|bar|crossbar)\b/.test(t)) return true;
  if (/\b(saved|blocked|missed)\s*[\.\!]?\s*$/i.test(t)) return true;
  return false;
}

/**
 * Commentary that RESOLVES a locked set-piece (never opens markets).
 * Goals stay keyEvent-only; this covers kicks taken, cleared, saved, routine.
 */
export function classifyResolverCommentary(text: string): FeedEventType | undefined {
  const t = text.trim().toLowerCase();
  // Never invent goals from prose — structured keyEvents are authoritative.
  if (/^goal[!]|^¡?goooo*ol/i.test(t)) return undefined;

  if (isPostShotCommentary(text)) return 'miss';

  const taken =
    /\b(takes|took|delivers|delivered|struck|strike[sd]?|plays|played|hits|hit)\s+(the\s+)?(a\s+)?(direct\s+|short\s+)?free[- ]?kick\b/.test(
      t,
    ) ||
    /\bfree[- ]?kick\s+(is\s+)?(taken|played|delivered|worked|routine|short)\b/.test(t) ||
    /\b(plays?|played|touches?|touched)\s+(?:it\s+)?short\b/.test(t) ||
    /\bshort\s+pass\b/.test(t) ||
    /\bpass(?:es|ed)?\s+(?:it\s+)?short\b/.test(t) ||
    /\b(into the wall|hits? the wall|off the wall|deflected|headed clear|headed away|heads?\s+clear)\b/.test(
      t,
    ) ||
    /\b(cleared|clearance|gathered by|caught by|collected by)\b/.test(t) ||
    /\b(tiro libre|falta)\b.{0,60}\b(corto|corta|juega|toca|muro|rechaz|despej)/.test(t) ||
    /\b(remate|disparo)\s+(parado|fallado|bloqueado|desviado|fuera)\b/.test(t);
  if (taken) return 'play_end';

  return undefined;
}

/** Build-up prose that can still be a timely chance (before the shot). */
export function isPreShotBuildUp(text: string): boolean {
  return isMomentumBuildUp(text);
}

/** EARLY momentum — not box entry / shot imminent (too late for a fair market). */
export function isMomentumBuildUp(text: string): boolean {
  if (isPostShotCommentary(text)) return false;
  const t = text.toLowerCase();
  if (/\b(into the box|in the (?:box|area|penalty)|worked into|played into|whipped in|crosses? into|one[-\s]?on[-\s]?one|clear chance|big chance)\b/.test(t)) {
    return false;
  }
  return /\b(surging forward|pushing forward|on the attack|in the final third|attacking third|attacking half|building (?:an )?attack|building pressure|counter[- ]?attack|breaks? forward|drives? forward|press(?:es|ing)? forward|overloads?|quick transition|winning the ball back|in possession|zona ofensiva|campo contrario|en ataque|presi[oó]n (?:alta|ofensiva)|avanzando)\b/.test(
    t,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// COMMENTARY PATTERNS — phrase → event type. First match wins (most dangerous
// first). Only PRE-SHOT build-up; post-shot lines are rejected in classifyCommentary.
// ───────────────────────────────────────────────────────────────────────────
export const COMMENTARY_PATTERNS: { type: FeedEventType; re: RegExp }[] = [
  // VAR review — opens a VAR market. The SUBJECT (penalty vs red card) is decided
  // downstream from the text by varReviewTrigger; here we just detect "a review".
  {
    type: 'var_check',
    re: /\b(VAR|video assistant|checking|review(?:ing)?)\b[^.]{0,80}\b(penalty|handball|foul|possible|red card|sending[- ]?off|violent|serious foul)\b/i,
  },
  { type: 'var_check', re: /\b(penalty|red[- ]?card) (?:check|review|appeal)\b/i },
  { type: 'var_check', re: /\bVAR\b[^.]{0,40}\b(red|sending[- ]?off|dismissal)\b/i },
  // A VAR decision/check about a CARD (incl. "VAR Decision: No card change", which
  // ESPN sometimes prints right before the card is actually shown). Also catches a
  // referee heading to the pitchside monitor / on-field review.
  { type: 'var_check', re: /\bVAR\b[^.]{0,40}\b(card|decision|check)\b/i },
  { type: 'var_check', re: /\b(on[- ]field review|pitchside monitor|checks the monitor|goes to the monitor|revisi[oó]n del var|revisa el monitor)\b/i },
  // NOTE: cards are bettable ONLY under VAR (above) — instant cards have no window.
  // Penalties from commentary (anchored — "penalty area" etc. is gated keyEvent-only).
  { type: 'penalty', re: /^penalty(?:\s+awarded)?(?:\s+to)?\s+/i },
  { type: 'penalty', re: /^penalti/i },
  // Corners from ESPN's canonical line: "Corner, Türkiye. Conceded by X." Anchored so
  // "corner flag" / "into the corner" never match. Spanish: "Saque/Tiro de esquina".
  { type: 'corner', re: /^corner,\s/i },
  { type: 'corner', re: /^(?:saque|tiro)\s+de\s+esquina\b/i },
  { type: 'free_kick', re: /\bwins a free kick\b/i },
  { type: 'free_kick', re: /\bha recibido una falta\b/i },
  // Clear, dangerous PRE-SHOT chances → dangerous_attack (never post-shot lines).
  {
    type: 'dangerous_attack',
    re: /\b(dangerous|through ball|clear chance|big chance|golden chance|breaks? (?:free|clear|through)|counter[-\s]?attack|cut[-\s]?back|rebound falls|pase en profundidad|contraataque|ocasi[oó]n (?:clara|de gol))\b/i,
  },
  // Early momentum → attack (AI judges; never box-entry / shot-imminent phrases).
  {
    type: 'attack',
    re: /\b(surging forward|pushing forward|on the attack|in the final third|attacking third|attacking half|building (?:an )?attack|building pressure|press(?:es|ing)? forward|breaks? forward|drives? forward|counter[- ]?attack|quick transition|in possession|overloads?|zona ofensiva|campo contrario|en ataque|presi[oó]n (?:alta|ofensiva)|avanzando)\b/i,
  },
];

// ───────────────────────────────────────────────────────────────────────────
// GAME CONTEXT — parse the messy clock string into something the AI + the
// window math can reason about (urgency, period, how close the game is).
// ───────────────────────────────────────────────────────────────────────────
export type Period = '1H' | '2H' | 'ET' | 'PK' | 'unknown';

export interface GameContext {
  period: Period;
  /** True when the clock shows added/stoppage time ("90+3'"). */
  isStoppage: boolean;
  /** True in extra time (after 90'). */
  isExtraTime: boolean;
  /** Rough minutes of regulation left in the current half (0 in stoppage/ET). */
  minutesLeft: number;
  /** scoreHome - scoreAway. */
  scoreMargin: number;
  /** True when one goal or fewer separates the teams (the tense, bettable kind). */
  isClose: boolean;
}

/** Parse "45'", "45+2'", "45'+1'", "90+3'", "HT", etc. into structured context. */
export function parseGameContext(game: GameState): GameContext {
  const { base, stopp } = parseClockKey(game.clock);
  const isStoppage = stopp > 0;
  let period: Period = 'unknown';
  if (base > 0) {
    if (base <= 45) period = '1H';
    else if (base <= 90) period = '2H';
    else if (base <= 120) period = 'ET';
    else period = 'PK';
  }
  const isExtraTime = base > 90 && base <= 120;
  const halfEnd = period === '1H' ? 45 : period === '2H' ? 90 : 120;
  const minutesLeft = period === 'unknown' || isStoppage ? 0 : Math.max(0, halfEnd - base);
  const scoreMargin = game.scoreHome - game.scoreAway;
  return {
    period,
    isStoppage,
    isExtraTime,
    minutesLeft,
    scoreMargin,
    isClose: Math.abs(scoreMargin) <= 1,
  };
}

/**
 * THE HT/FT BOUNDARY GUARD (deterministic — works with or without the AI director).
 * True when the half is in STOPPAGE time, where the whistle is imminent and
 * unpredictable. A short play-dependent market opened now ("a shot this spell?", "who
 * threatens next?", "2+ corners in the next 4 min?") would just be cut off by the whistle
 * → an unfair VOID/NO. Near the whistle the market that makes sense is "a goal before the
 * half?" (goal_in_stoppage), which the period logic opens — so we SUPPRESS new short
 * play/window/count/versus opens here. This is exactly the user's example: don't open a
 * "shot in 10s" market as the half dies, alongside the added-time goal market.
 *
 * Regulation play is NOT guarded — it continues into stoppage, so a 90s window opened at
 * 44' is fine. Only the stoppage zone itself (where the whistle can land any moment) is
 * guarded. Extra time is left to the ET period markets.
 */
export function inWhistleZone(game: GameState): boolean {
  const ctx = parseGameContext(game);
  return ctx.isStoppage && (ctx.period === '1H' || ctx.period === '2H');
}

/**
 * Stretch a betting window when the moment matters more — the dying minutes of a
 * tight game, stoppage time, extra time. Gives bettors a beat longer to get in
 * on the markets that count, exactly when the action spikes.
 */
export function windowMultiplier(ctx: GameContext): number {
  let f = 1;
  if (ctx.isExtraTime) f *= 1.5;
  if (ctx.isStoppage) f *= 1.4;
  if (ctx.isClose && (ctx.minutesLeft <= 5 || ctx.isStoppage || ctx.isExtraTime)) f *= 1.3;
  return f;
}

/** High AI confidence → slightly longer window; low → tighter. */
export function confidenceWindowMs(baseMs: number, confidence: number, game: GameState): number {
  const ctx = parseGameContext(game);
  const conf = Math.min(1, Math.max(0, confidence));
  return Math.round(baseMs * (0.88 + conf * 0.22) * windowMultiplier(ctx));
}

// ───────────────────────────────────────────────────────────────────────────
// PERIOD MARKETS — longer-lived, state-triggered markets (not tied to a single
// play). e.g. on entering extra time of a tight game: "Will Scotland score in
// extra time?" — short bet window, but the question lives across the period.
// ───────────────────────────────────────────────────────────────────────────
export const PERIOD_MARKET = {
  enabled: true,
  /** Bet window — snappy (you can't bet once it locks), capped at the 8s fast-reaction max. */
  betWindowMs: 8000,
  /** Safety net after lock — primary settlement is on matching goal or full time. */
  resolveWindowMs: 25 * 60_000,
  /** Only when the game is this close (≤ N goals) — a blowout isn't bettable. */
  maxMargin: 1,
};

export type PeriodMarketPhase = 'stoppage_1h' | 'stoppage_2h' | 'extra_time';

/** Dedupe key so a feed restart does not open a second before-whistle market. */
export function periodMarketKey(gameId: string, phase: PeriodMarketPhase): string {
  return `period:${phase}:${gameId}`;
}

export function periodMarketKeyForGame(game: GameState): string | undefined {
  const phase = periodMarketPhase(game);
  return phase ? periodMarketKey(game.gameId, phase) : undefined;
}

export function periodMarketPhase(game: GameState): PeriodMarketPhase | undefined {
  const ctx = parseGameContext(game);
  if (ctx.isExtraTime) return 'extra_time';
  if (!ctx.isStoppage) return undefined;
  if (ctx.period === '1H') return 'stoppage_1h';
  if (ctx.period === '2H') return 'stoppage_2h';
  return undefined;
}

/** Stable pick from a list — same game + phase → same line (tests stay deterministic). */
function pickPeriodQuestion(variants: string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return variants[Math.abs(h) % variants.length]!;
}

const HT_STOPPAGE_QUESTIONS = [
  'Goal before half-time?',
  'Another goal before half-time?',
  'A goal in first-half stoppage?',
  'One more before half-time?',
];

// Every FT variant must NAME full-time/FT so the client labels it "Before FT" (not "Before
// half") — a bare "before the whistle" is ambiguous between the two stoppage periods.
const FT_STOPPAGE_QUESTIONS = [
  'Goal before full-time?',
  'Another goal before full-time?',
  'A goal in stoppage before full-time?',
  'One more before full-time?',
];

const ET_LEVEL_QUESTIONS = [
  'A goal in extra time?',
  'Either team to score in extra time?',
  'A goal coming in extra time?',
  'Goal in ET?',
];

/**
 * Build the before-whistle period market trigger when conditions are met, or null.
 * Stoppage questions resolve on HT/FT whistle, never on an announced X-minute timer.
 */
export function buildPeriodMarketTrigger(game: GameState): MarketTrigger | null {
  if (!PERIOD_MARKET.enabled) return null;
  const ctx = parseGameContext(game);
  const margin = game.scoreHome - game.scoreAway;

  // Added-time (stoppage) markets ALWAYS open — the tensest moment of the half,
  // regardless of the scoreline. (The extra-time comeback markets below keep the
  // close-game gate, which only makes sense there.)
  if (ctx.isStoppage && ctx.period === '1H') {
    return {
      gameId: game.gameId,
      question: pickPeriodQuestion(HT_STOPPAGE_QUESTIONS, `${game.gameId}:stoppage_1h`),
      kind: 'goal_in_stoppage',
      slot: 'period',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.28,
    };
  }

  if (ctx.isStoppage && ctx.period === '2H') {
    return {
      gameId: game.gameId,
      question: pickPeriodQuestion(FT_STOPPAGE_QUESTIONS, `${game.gameId}:stoppage_2h`),
      kind: 'goal_in_stoppage',
      slot: 'period',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.34,
    };
  }

  if (!ctx.isExtraTime) return null;
  if (!ctx.isClose) return null;
  if (Math.abs(margin) > PERIOD_MARKET.maxMargin) return null;

  if (margin < 0) {
    const name = game.home.name;
    const qs = [
      `${name} to score in extra time?`,
      `Can ${name} score in extra time?`,
      `${name} to find a goal in ET?`,
      `Goal for ${name} in extra time?`,
    ];
    return {
      gameId: game.gameId,
      question: pickPeriodQuestion(qs, `${game.gameId}:et_home`),
      kind: 'goal_in_extra_time',
      slot: 'period',
      team: 'home',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.32,
    };
  }
  if (margin > 0) {
    const name = game.away.name;
    const qs = [
      `${name} to score in extra time?`,
      `Can ${name} score in extra time?`,
      `${name} to find a goal in ET?`,
      `Goal for ${name} in extra time?`,
    ];
    return {
      gameId: game.gameId,
      question: pickPeriodQuestion(qs, `${game.gameId}:et_away`),
      kind: 'goal_in_extra_time',
      slot: 'period',
      team: 'away',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.32,
    };
  }
  return {
    gameId: game.gameId,
    question: pickPeriodQuestion(ET_LEVEL_QUESTIONS, `${game.gameId}:et_level`),
    kind: 'goal_in_extra_time',
    slot: 'period',
    windowMs: PERIOD_MARKET.betWindowMs,
    trueProb: 0.45,
  };
}
