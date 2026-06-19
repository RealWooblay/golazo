// ───────────────────────────────────────────────────────────────────────────
// MARKET TUNING — the ONE place that decides what becomes a market, when, for
// how long, and how sure we must be. Everything market-shaped (the ESPN
// classifier, the AI watcher, the orchestrator's timers) reads from here, so
// tuning the product is editing this file and nothing else.
// ───────────────────────────────────────────────────────────────────────────
import type { FeedEvent, GameState } from '@golazo/core';

export type MarketTier = 'set_piece' | 'fuzzy';
export type OpenableType =
  | 'penalty'
  | 'corner'
  | 'free_kick'
  | 'dangerous_attack'
  | 'attack';

/** Everything we know about ONE kind of bettable moment. */
export interface MarketTypeKnob {
  /** set_piece → rules open it instantly (inherently a chance). fuzzy → the AI judges + scores. */
  tier: MarketTier;
  /** How long betting stays OPEN before the market locks (must close before the play resolves). */
  betWindowMs: number;
  /** After lock, how long to wait for a goal/miss before settling the goal-question NO. */
  resolveWindowMs: number;
  /** fuzzy only: minimum AI confidence (0..1) to open. set_piece ignores this. */
  minConfidence: number;
}

/**
 * Per-type knobs. To make a moment more/less bettable, or change its window,
 * edit the numbers here — nothing else.
 *
 * resolveWindowMs is deliberately short (~10-14s): a chance resolves within
 * seconds of the play. HONEST TRADE-OFF: a delayed free feed can report a real
 * goal late; too short → we mis-settle it NO. Fast + accurate needs a licensed
 * low-latency feed. These values bias toward a responsive UX.
 */
export const MARKET_TYPES: Record<OpenableType, MarketTypeKnob> = {
  penalty: { tier: 'set_piece', betWindowMs: 9000, resolveWindowMs: 14000, minConfidence: 0 },
  corner: { tier: 'set_piece', betWindowMs: 7000, resolveWindowMs: 12000, minConfidence: 0 },
  free_kick: { tier: 'fuzzy', betWindowMs: 7000, resolveWindowMs: 12000, minConfidence: 0.6 },
  dangerous_attack: { tier: 'fuzzy', betWindowMs: 6000, resolveWindowMs: 10000, minConfidence: 0.6 },
  attack: { tier: 'fuzzy', betWindowMs: 6000, resolveWindowMs: 10000, minConfidence: 0.55 },
};

export function knobFor(type: FeedEvent['type']): MarketTypeKnob | undefined {
  return (MARKET_TYPES as Record<string, MarketTypeKnob>)[type];
}

export function tierOf(type: FeedEvent['type']): MarketTier | 'ignore' {
  return knobFor(type)?.tier ?? 'ignore';
}

// ───────────────────────────────────────────────────────────────────────────
// COMMENTARY PATTERNS — phrase → event type. First match wins (most dangerous
// first). EXPANDED to catch live attacks that were slipping through ("chance",
// "header", "cut-back", "rebound", "scramble", "shot/effort in the box", ...).
// ───────────────────────────────────────────────────────────────────────────
export const COMMENTARY_PATTERNS: { type: OpenableType; re: RegExp }[] = [
  // Set-pieces — the award is published BEFORE the kick, so a market can open
  // pre-outcome. "penalty area/box/spot" is a location, not an award → excluded.
  { type: 'penalty', re: /\bpenalty\b(?!\s*(area|box|spot))/i },
  { type: 'corner', re: /\bcorner\b/i },
  { type: 'free_kick', re: /\b(free[-\s]?kick|direct free|indirect free)\b/i },
  // Clear, dangerous chances → dangerous_attack.
  {
    type: 'dangerous_attack',
    re: /\b(dangerous|through ball|one[-\s]?on[-\s]?one|clear chance|big chance|golden chance|breaks? (?:free|clear|through)|counter[-\s]?attack|cut[-\s]?back|rebound|header (?:from|at|towards)|(?:shot|effort|strike|attempt|volley)\b[^.]*\b(?:box|goal|net|post|bar|target)\b|saved|tipped over|off the (?:line|post|bar))/i,
  },
  // General forward momentum → attack (looser; many fizzle, so lower confidence).
  {
    type: 'attack',
    re: /\b(into the box|in the (?:box|area|penalty)|\battack\b|chance|surging forward|building (?:an )?attack|pressure|press(?:es|ing)? forward|breaks? forward|drives? forward|dribbl|takes? on|whipped (?:in|cross)|crosses? (?:in|into)|scramble|loose ball in)/i,
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

// ───────────────────────────────────────────────────────────────────────────
// PERIOD MARKETS — longer-lived, state-triggered markets (not tied to a single
// play). e.g. on entering extra time of a tight game: "Will Korea score in
// extra time?" — short bet window, but the question lives across the period.
// ───────────────────────────────────────────────────────────────────────────
export const PERIOD_MARKET = {
  enabled: true,
  /** Bet window — still snappy (you can't bet once it locks), per the "10s to bet" idea. */
  betWindowMs: 12000,
  /** The question lives a long time: settle NO if the period ends with no goal. */
  resolveWindowMs: 8 * 60_000,
  /** Only when the game is this close (≤ N goals) — a blowout isn't bettable. */
  maxMargin: 1,
};
