/**
 * Play-phase helpers — phase inference (for metrics / the momentum bar context),
 * goal attribution from ESPN's own keyEvent text, and the kind predicates the
 * resolver uses. Goal attribution reads ESPN's structured goal text (parseGoalSource)
 * rather than arbitrary commentary, so a set-piece market only settles YES on a goal
 * that ESPN itself describes as coming from that set piece.
 */
import type { FeedEvent } from '@golazo/core';

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
