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
 * Does this event RESOLVE an open market (and to what)?
 * Kind-aware: a goal only settles goal markets; a yellow card only settles card markets.
 */
export function outcomeFromEvent(ev: FeedEvent, marketKind?: string): 'YES' | 'NO' | null {
  if (!marketKind) {
    if (ev.type === 'goal') return 'YES';
    if (ev.type === 'miss') return 'NO';
    return null;
  }

  // Goal-scoring markets — resolve on real feed evidence, never on a blind timer.
  if (marketKind === 'penalty_scored' || marketKind.startsWith('goal_from')) {
    if (ev.type === 'goal') return 'YES';
    if (ev.type === 'miss') return 'NO';
    if (ev.type === 'play_end') return 'NO';
    // Set-piece shot taken with no goal → NO (FK/corner/penalty only).
    if (
      ev.type === 'shot' &&
      (marketKind === 'goal_from_free_kick' ||
        marketKind === 'goal_from_corner' ||
        marketKind === 'penalty_scored')
    ) {
      return 'NO';
    }
    return null;
  }
  if (marketKind === 'goal_in_extra_time') {
    if (ev.type === 'goal') return 'YES';
    return null;
  }

  // "On this play" possession markets — the bet is whether the MOVE comes to
  // something. A shot or goal during the move = YES; the play breaking down
  // (possession lost / cleared / timer expiry → play_end) = NO. This is the
  // fast-cycling open-play market, NOT a strict goal question.
  if (marketKind === 'chance_from_play') {
    if (ev.type === 'goal') return 'YES';
    if (ev.type === 'shot') return 'YES';
    if (ev.type === 'miss') return 'YES';
    if (ev.type === 'play_end') return 'NO';
    return null;
  }

  // VAR → penalty decision (award, not scored)
  if (marketKind === 'penalty_awarded') {
    if (ev.type === 'penalty') return 'YES';
    if (ev.type === 'var_penalty_denied') return 'NO';
    return null;
  }

  // VAR → possible RED card. Resolves YES only when a red card is actually shown
  // (a second yellow maps to red upstream). NEVER a blind early NO — the review
  // takes time, so we wait for the real card event (else the long window times out).
  if (marketKind === 'red_card_given') {
    if (ev.type === 'red_card') return 'YES';
    return null;
  }

  return null;
}

/** Market kinds that may settle NO when a short resolve window expires without a YES event. */
export function kindSettlesNoOnTimeout(kind: string): boolean {
  // Goal-question markets NEVER auto-NO on a timer — only goal/miss/play_end/shot.
  // "On this play" markets DO settle NO on timer: a fizzled move = no shot = NO.
  return (
    kind === 'chance_from_play' ||
    kind === 'goal_in_extra_time' ||
    kind === 'penalty_awarded' ||
    kind === 'red_card_given'
  );
}

function nameFor(team: Team | undefined, ctx: WatcherContext): string {
  if (team === 'home') return ctx.homeName ?? 'Home';
  if (team === 'away') return ctx.awayName ?? 'Away';
  return 'They';
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
