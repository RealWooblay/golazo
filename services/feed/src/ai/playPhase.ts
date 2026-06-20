/**
 * Play-phase logic — when does a set-piece / chance START and END, and does a
 * goal count for the market we opened?
 *
 * No hardcoded commentary keywords for OPENING. For RESOLUTION we use:
 *   • Structured ESPN event TYPES (miss, shot, new set-piece, open-play attack)
 *   • Commentary-derived resolver events (classifyResolverCommentary)
 *   • ESPN goal keyEvent TEXT (how they describe the score)
 *   • AI phase resolver (phaseResolver.ts) reading the commentary stream
 */
import type { FeedEvent, Team } from '@golazo/core';

export type GoalSourceVerdict = 'yes' | 'no' | 'ambiguous';

/** Live match phase inferred from structured + commentary events. */
export type PlayPhaseState = 'calm' | 'buildup' | 'set_piece' | 'shooting' | 'dead_ball';

/** Infer phase from a single event (for metrics + AI context). */
export function inferPlayPhase(ev: FeedEvent): PlayPhaseState {
  if (ev.meta?.delay === 'start') return 'dead_ball';
  switch (ev.type) {
    case 'goal':
    case 'miss':
    case 'shot':
      return 'shooting';
    case 'corner':
    case 'penalty':
    case 'free_kick':
      return 'set_piece';
    case 'dangerous_attack':
      return 'shooting';
    case 'attack':
      return 'buildup';
    case 'calm':
      return 'calm';
    default:
      return 'calm';
  }
}

/** Transition the global phase given a new event. */
export function transitionPlayPhase(current: PlayPhaseState, ev: FeedEvent): PlayPhaseState {
  const next = inferPlayPhase(ev);
  if (next === 'calm' && current !== 'calm') return current;
  if (ev.type === 'goal' || ev.type === 'miss') return 'calm';
  if (ev.meta?.delay === 'end') return current === 'dead_ball' ? 'calm' : current;
  return next;
}

/** ESPN corroboration: goal keyEvent + matching commentary in same batch → high confidence. */
export function goalCorroborated(goal: FeedEvent, batchCommentary: FeedEvent[]): boolean {
  if (goal.type !== 'goal') return false;
  const team = goal.team;
  const t = goal.text.toLowerCase();
  return batchCommentary.some((c) => {
    const ct = c.text.toLowerCase();
    if (!/\b(goal|gol|goooo*ol)\b/.test(ct)) return false;
    if (team && c.team && c.team !== team) return false;
    return ct.includes(t.slice(0, 20)) || (team !== undefined && c.team === team);
  });
}

export function isGoalQuestionKind(kind: string): boolean {
  return kind.startsWith('goal_from') || kind === 'penalty_scored';
}

/**
 * Kinds whose live PHASE we track (loss of possession / move ending → resolve).
 * Strict goal questions PLUS the fast "on this play" possession market.
 */
export function isPlayMarketKind(kind: string): boolean {
  return isGoalQuestionKind(kind) || kind === 'chance_from_play';
}

/**
 * A structured feed event that ends the current play phase (FK taken & cleared,
 * open play resumed, new set-piece, commentary resolver, etc.).
 */
export function endsPlayPhase(
  ev: FeedEvent,
  marketTeam: Team | undefined,
  openerType: FeedEvent['type'] | undefined,
): boolean {
  // Stoppage pauses the match — does not end the phase.
  if (ev.meta?.delay === 'start') return false;
  // Play resumes after a structured delay — the set-piece phase is over.
  if (ev.type === 'calm' && ev.meta?.delay === 'end') {
    return openerType === 'free_kick' || openerType === 'corner' || openerType === 'penalty';
  }

  switch (ev.type) {
    case 'miss':
    case 'shot':
    case 'play_end':
      return true;
    case 'corner':
    case 'free_kick':
    case 'penalty':
      return true;
    case 'dangerous_attack':
    case 'attack':
      // Open play has resumed — a parked FK phase is over even if ESPN never
      // emitted a "wall" keyEvent.
      if (openerType === 'free_kick' || openerType === 'corner') return true;
      // "On this play" possession market: the OTHER team now has the ball, so our
      // move is over (possession lost → NO). A same-team attack continues the move.
      if (marketTeam && ev.team !== undefined && ev.team !== marketTeam) return true;
      return false;
    case 'goal':
      // Opponent goal ends our phase; same-team goal is handled as resolution.
      return !!marketTeam && ev.team !== undefined && ev.team !== marketTeam;
    default:
      return false;
  }
}

/** Wall-clock ms a locked moment market may block new opens before force-settle. */
export const STALE_LOCKED_BLOCK_MS = 75_000;

/**
 * True when a locked goal-question should settle NO even without a resolver event
 * (clock moved on, or locked too long — never leave users hanging).
 */
export function shouldForceSettleLockedNo(
  kind: string,
  lockedAgeMs: number,
  resolveWindowMs: number,
  openClockMin: number | undefined,
  liveClockMin: number,
  phaseActive: boolean,
): boolean {
  if (!phaseActive || !isPlayMarketKind(kind)) return false;
  if (
    openClockMin !== undefined &&
    liveClockMin > openClockMin + maxGoalClockDrift(kind)
  ) {
    return true;
  }
  const maxLockWait = Math.max(resolveWindowMs * 2, 60_000);
  if (lockedAgeMs > maxLockWait) return true;
  if (lockedAgeMs > STALE_LOCKED_BLOCK_MS) return true;
  return false;
}

/**
 * Parse ESPN's structured goal keyEvent text to see if it scores FROM the moment
 * we bet on. This reads ESPN's own description, not arbitrary commentary.
 */
export function parseGoalSource(goalText: string, marketKind: string): GoalSourceVerdict {
  const t = goalText.toLowerCase();

  if (marketKind === 'goal_from_free_kick') {
    if (/\b(header|shot|scores)[^.]{0,40}\b(direct )?free[- ]?kick\b/.test(t)) return 'yes';
    if (/\bfrom (?:a |the )?free[- ]?kick\b/.test(t)) return 'yes';
    // Assisted / open-play / recycled possession → NOT a direct FK goal.
    if (/\bassisted by\b/.test(t)) return 'no';
    if (/\b(through ball|cross|counter[- ]?attack|corner|penalty|rebound|loose ball)\b/.test(t)) {
      return 'no';
    }
    return 'ambiguous';
  }

  if (marketKind === 'goal_from_corner') {
    if (/\bfrom (?:a |the )?corner\b/.test(t)) return 'yes';
    if (/\bcorner\b/.test(t) && /\b(header|goal|scores)\b/.test(t)) return 'yes';
    if (/\bassisted by\b/.test(t) && !/\bcorner\b/.test(t)) return 'no';
    if (/\b(through ball|counter|free[- ]?kick|penalty)\b/.test(t)) return 'no';
    return 'ambiguous';
  }

  if (marketKind === 'penalty_scored') {
    if (/\bpenalty\b/.test(t) && !/\bmissed\b/.test(t)) return 'yes';
    return 'ambiguous';
  }

  if (marketKind === 'goal_from_open_play') {
    if (/\b(penalty|free[- ]?kick|corner)\b/.test(t)) return 'no';
    return 'ambiguous';
  }

  return 'ambiguous';
}

/** Max match-clock drift (minutes) for a goal to still belong to the opener. */
export function maxGoalClockDrift(kind: string): number {
  if (kind === 'goal_from_free_kick') return 1.5;
  if (kind === 'goal_from_corner') return 1.25;
  if (kind === 'penalty_scored') return 2;
  return 1.5;
}
