import type { FeedEvent, MarketTrigger, Team } from './types';

/**
 * The rule-based "watcher": turns a raw feed event into a bettable MarketTrigger,
 * or null if the moment isn't worth a market.
 */

interface AttackSpec {
  kind: string;
  prob: number;
  windowMs: number;
  label: (teamName: string) => string;
}

const SPECS: Partial<Record<FeedEvent['type'], AttackSpec>> = {
  penalty: {
    kind: 'penalty_scored',
    prob: 0.78,
    windowMs: 9000,
    label: (t) => `${t} penalty — will it be SCORED?`,
  },
  dangerous_attack: {
    // "On this play" possession market: resolves on a shot/goal (YES) or when the
    // move fizzles / possession is lost / the timer runs out (NO). Opens readily.
    kind: 'chance_from_play',
    prob: 0.5,
    windowMs: 6000,
    label: (t) => `${t} breaking forward — SHOT this move?`,
  },
  attack: {
    kind: 'chance_from_play',
    prob: 0.35,
    windowMs: 6000,
    label: (t) => `${t} on the ball — SHOT this move?`,
  },
  corner: {
    kind: 'goal_from_corner',
    prob: 0.15,
    windowMs: 7000,
    label: (t) => `${t} corner — GOAL from it?`,
  },
  free_kick: {
    kind: 'goal_from_free_kick',
    prob: 0.17,
    windowMs: 7000,
    label: (t) => `${t} free kick — GOAL?`,
  },
  // NOTE: var_check is handled by `varReviewTrigger` (below), not this table — its
  // market depends on WHAT the VAR is reviewing (a possible red card vs a penalty).
};

/**
 * A VAR review that's about a possible SENDING OFF (red), not a penalty. Includes
 * the generic word "card" (ESPN's "VAR Decision: … card …" lines are card reviews),
 * but only when the text isn't explicitly about a penalty (penalties win below).
 */
const RED_CARD_VAR_RE =
  /\b(red card|\bcard\b|sending[- ]?off|sent off|dismissal|straight red|second yellow|violent conduct|serious foul play|tarjeta|tarjeta roja|expulsi[oó]n|doble amarilla|segunda amarilla)\b/i;
const PENALTY_VAR_RE = /\b(penalty|penalti|handball|hand ball|mano)\b/i;

/**
 * VAR review market. Cards under VAR ARE bettable (the review takes real time);
 * instant cards are not (no window). We pick the subject from the review text:
 *   • mentions a sending-off / red / violent conduct → "VAR review — RED card?"
 *   • otherwise                                       → "VAR review — penalty awarded?"
 * Both are TEAMLESS ("will THIS review produce X?") and resolve on the real event.
 */
function varReviewTrigger(ev: FeedEvent): MarketTrigger {
  // Penalty wins if the review explicitly mentions one; otherwise a card mention
  // (incl. generic "card") makes it a red-card review.
  const isCard = !PENALTY_VAR_RE.test(ev.text) && RED_CARD_VAR_RE.test(ev.text);
  return {
    gameId: ev.gameId,
    question: isCard ? `VAR review — RED card?` : `VAR review — will a penalty be awarded?`,
    kind: isCard ? 'red_card_given' : 'penalty_awarded',
    windowMs: 12000,
    trueProb: isCard ? 0.45 : 0.42,
  };
}

export interface WatcherContext {
  homeName?: string;
  awayName?: string;
}

/** Kinds whose question is about a SPECIFIC team — never open these without one. */
const TEAMLESS_KINDS = new Set(['penalty_awarded', 'red_card_given']);

/** A market is team-bound unless it's an explicitly teamless kind (e.g. VAR review). */
export function requiresTeam(kind: string): boolean {
  return !TEAMLESS_KINDS.has(kind);
}

/** Pure mapping FeedEvent -> MarketTrigger | null. */
export function triggerFromEvent(ev: FeedEvent, ctx: WatcherContext = {}): MarketTrigger | null {
  // VAR reviews choose their market by subject (red card vs penalty), teamless.
  if (ev.type === 'var_check') return varReviewTrigger(ev);

  const spec = SPECS[ev.type];
  if (!spec) return null;

  // No team → no market. A team-bound question with an unknown side renders as
  // "They free kick — GOAL?", which we never want; and we can't resolve it by team.
  if (!ev.team && requiresTeam(spec.kind)) return null;

  const teamName = nameFor(ev.team, ctx);
  const prob = typeof ev.meta?.prob === 'number' ? (ev.meta.prob as number) : spec.prob;

  return {
    gameId: ev.gameId,
    question: spec.label(teamName),
    kind: spec.kind,
    team: ev.team,
    windowMs: spec.windowMs,
    trueProb: clamp(prob, 0.03, 0.97),
  };
}

/**
 * Does a feed event resolve an open market YES?
 *
 * THE ONE RULE: an event can ONLY ever cause YES. NO is written in exactly one
 * place — the per-tick deadline sweep (`settleExpired`) — never from an event.
 * So this returns 'YES' for a qualifying event, else null (no opinion). It never
 * returns NO: a `miss` / `play_end` / opponent attack can no longer pre-empt a
 * genuinely-late YES that arrives in a later poll on the ~2-min ESPN feed.
 *
 * Kind-aware: a goal only settles goal markets; a red card only settles card markets.
 */
export function outcomeFromEvent(ev: FeedEvent, marketKind?: string): 'YES' | null {
  if (!marketKind) {
    if (ev.type === 'goal') return 'YES';
    return null;
  }

  // Goal-scoring markets — YES only on a real goal (attribution via parseGoalSource).
  if (marketKind === 'penalty_scored' || marketKind.startsWith('goal_from')) {
    if (ev.type === 'goal') return 'YES';
    return null;
  }
  if (marketKind === 'goal_in_stoppage' || marketKind === 'goal_in_extra_time') {
    if (ev.type === 'goal') return 'YES';
    return null;
  }

  // "On this play" possession market — YES on a shot/goal during the move.
  // A fizzled move (no qualifying event by the deadline) settles NO via the sweep.
  if (marketKind === 'chance_from_play') {
    if (ev.type === 'goal') return 'YES';
    if (ev.type === 'shot') return 'YES';
    if (ev.type === 'miss') return 'YES';
    return null;
  }

  // Momentum time-boxed markets — pure wall-clock windows. YES if the team gets a
  // shot/goal (shot_in_window) or scores (score_in_window) before resolveAt; NO via
  // the deadline sweep otherwise. These never track a play phase.
  if (marketKind === 'shot_in_window') {
    if (ev.type === 'goal' || ev.type === 'shot' || ev.type === 'miss') return 'YES';
    return null;
  }
  if (marketKind === 'score_in_window') {
    if (ev.type === 'goal') return 'YES';
    return null;
  }

  // VAR → penalty decision (award, not scored). YES on a real penalty; NO via sweep.
  if (marketKind === 'penalty_awarded') {
    if (ev.type === 'penalty') return 'YES';
    return null;
  }

  // VAR → possible RED card. YES only when a red card is actually shown (a second
  // yellow maps to red upstream). NO via the deadline sweep if the review passes.
  if (marketKind === 'red_card_given') {
    if (ev.type === 'red_card') return 'YES';
    return null;
  }

  return null;
}

function nameFor(team: Team | undefined, ctx: WatcherContext): string {
  if (team === 'home') return ctx.homeName ?? 'Home';
  if (team === 'away') return ctx.awayName ?? 'Away';
  return 'They';
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
