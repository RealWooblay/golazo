// ───────────────────────────────────────────────────────────────────────────
// MARKET TUNING — the ONE place that decides what becomes a market, when, for
// how long, and how sure we must be. Everything market-shaped (the ESPN
// classifier, the AI watcher, the orchestrator's timers) reads from here, so
// tuning the product is editing this file and nothing else.
// ───────────────────────────────────────────────────────────────────────────
import type { FeedEvent, FeedEventType, GameState, MarketTrigger, Team } from '@golazo/core';
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
  penalty: { tier: 'set_piece', betWindowMs: 12_000, resolveWindowMs: 50_000 },
  corner: { tier: 'set_piece', betWindowMs: 12_000, resolveWindowMs: 90_000 },
  // A free kick is a set piece like any other — if one is awarded and the slot is
  // free, open a market. The only free kick we DON'T open is a clearly defensive /
  // own-half one (filtered in the watcher); everything else just opens, no AI needed.
  free_kick: { tier: 'set_piece', betWindowMs: 12_000, resolveWindowMs: 90_000 },
  // VAR reviews take real time (often 60–120s + feed lag) — a short window made
  // card/penalty markets settle NO before the decision was even reported. Wait it out.
  var_check: { tier: 'set_piece', betWindowMs: 14_000, resolveWindowMs: 120_000 },
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
  return 0.5;
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
  return last !== undefined && last >= openClockMin - 0.5;
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
 * market off ANY weighted event. Lower than the old shot threshold (3.5) to drive
 * more volume; the markets are pure wall-clock windows so they resolve cleanly.
 */
export const MOMENTUM_OPEN_THRESHOLD = 3.0;

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
      return 90_000; // organize, deliver, scramble, recycle
    case 'goal_from_free_kick':
      return 90_000; // wall, routine or direct shot
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
      return 180_000;
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
 * Exactly ONE market is live at a time — you bet on the moment happening NOW.
 * The product goal isn't parallel markets, it's a FAST FLOW: each market resolves
 * quickly (on real evidence, else a short timeout) so the next can open right
 * behind it. A moment that occurs while a market is live is IGNORED — never
 * queued and replayed later (that path only breeds stale, wrong markets).
 */
export const MAX_CONCURRENT_MARKETS = 1;

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

/** Parse "45'", "90+3'", "120'", "HT", etc. into structured context. */
export function parseGameContext(game: GameState): GameContext {
  const raw = (game.clock ?? '').trim();
  const m = raw.match(/(\d+)\s*(?:\+\s*(\d+))?/);
  const base = m && m[1] ? parseInt(m[1], 10) : 0;
  const isStoppage = !!(m && m[2]);
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
  /** Bet window — still snappy (you can't bet once it locks), per the "10s to bet" idea. */
  betWindowMs: 12000,
  /** Safety net after lock — primary settlement is on matching goal or full time. */
  resolveWindowMs: 25 * 60_000,
  /** Only when the game is this close (≤ N goals) — a blowout isn't bettable. */
  maxMargin: 1,
};

/** Dedupe key so a feed restart mid-ET doesn't open a second period market. */
export function periodMarketKey(gameId: string): string {
  return `period:et:${gameId}`;
}

/**
 * Build the extra-time period market trigger when conditions are met, or null.
 * Called on ET entry (and retried after a blocking moment market closes).
 */
export function buildPeriodMarketTrigger(game: GameState): MarketTrigger | null {
  if (!PERIOD_MARKET.enabled) return null;
  const ctx = parseGameContext(game);
  if (!ctx.isExtraTime || !ctx.isClose) return null;

  const margin = game.scoreHome - game.scoreAway;
  if (Math.abs(margin) > PERIOD_MARKET.maxMargin) return null;

  if (margin < 0) {
    return {
      gameId: game.gameId,
      question: `Will ${game.home.name} score in extra time?`,
      kind: 'goal_in_extra_time',
      team: 'home',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.32,
    };
  }
  if (margin > 0) {
    return {
      gameId: game.gameId,
      question: `Will ${game.away.name} score in extra time?`,
      kind: 'goal_in_extra_time',
      team: 'away',
      windowMs: PERIOD_MARKET.betWindowMs,
      trueProb: 0.32,
    };
  }
  return {
    gameId: game.gameId,
    question: `Will there be a goal in extra time?`,
    kind: 'goal_in_extra_time',
    windowMs: PERIOD_MARKET.betWindowMs,
    trueProb: 0.45,
  };
}
