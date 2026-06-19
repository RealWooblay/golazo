import type { FeedEvent, MarketTrigger, Team } from './types';

/**
 * The rule-based "watcher": turns a raw feed event into a bettable MarketTrigger,
 * or null if the moment isn't worth a market.
 *
 * This is the deterministic baseline the offline app uses. The feed *service*
 * swaps in an AI watcher (Claude) that reads the live commentary stream and can
 * phrase richer questions — but it emits the exact same MarketTrigger shape, so
 * the engine never knows the difference.
 *
 * KEY DESIGN RULE (from the research): we only ever open a market on a discrete,
 * "set" moment — a penalty, a corner, a free kick, the launch of an attack —
 * never mid-flight in a way that could already be decided. Each spec also closes
 * its betting window well before the play can resolve.
 */

interface AttackSpec {
  kind: string;
  prob: number; // fallback YES prob if the event/AI doesn't supply one
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
    kind: 'goal_from_open_play',
    prob: 0.34,
    windowMs: 6000,
    label: (t) => `${t} on the attack — GOAL?`,
  },
  attack: {
    kind: 'goal_from_open_play',
    prob: 0.16,
    windowMs: 6000,
    label: (t) => `${t} building — GOAL in this move?`,
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
};

export interface WatcherContext {
  homeName?: string;
  awayName?: string;
}

/** Pure mapping FeedEvent -> MarketTrigger | null. */
export function triggerFromEvent(ev: FeedEvent, ctx: WatcherContext = {}): MarketTrigger | null {
  const spec = SPECS[ev.type];
  if (!spec) return null;

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
 * Does this event RESOLVE the open market (and to what)?
 * Returns 'YES' on a goal, 'NO' on a miss/blocked/saved, null if unrelated.
 */
export function outcomeFromEvent(ev: FeedEvent): 'YES' | 'NO' | null {
  if (ev.type === 'goal') return 'YES';
  if (ev.type === 'miss') return 'NO';
  return null;
}

function nameFor(team: Team | undefined, ctx: WatcherContext): string {
  if (team === 'home') return ctx.homeName ?? 'Home';
  if (team === 'away') return ctx.awayName ?? 'Away';
  return 'They';
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
