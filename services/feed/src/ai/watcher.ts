/**
 * In-play WATCHER — turns the latest feed event into a bettable set-piece market,
 * or null. This is now PURE RULES: there is no AI judge, no confidence gate, no
 * fuzzy open-play path. The fragile "is this move going somewhere?" Haiku call has
 * been deleted; its volume is replaced by momentum time-boxed markets (opened in
 * the orchestrator off the deterministic momentum read). The only openers here are
 * unambiguous set-pieces (penalty / corner / free-kick / VAR), which open instantly
 * from rules — $0, no model, fully deterministic.
 */

import {
  triggerFromEvent,
  requiresTeam,
  type FeedEvent,
  type GameState,
  type MarketTrigger,
  type Team,
} from '@golazo/core';
import {
  tierOf as tuningTierOf,
  knobFor,
  isDefensiveSetPiece,
  isPostShotCommentary,
  confidenceWindowMs,
} from './marketTuning';

/** Cost tier of an event: a set-piece opens from rules, everything else is ignored. */
export type Tier = 'ignore' | 'set_piece';

/** Which cost tier an event falls into (from the central tuning). Exported for tests. */
export function tierOf(type: FeedEvent['type']): Tier {
  return tuningTierOf(type);
}

export interface AiWatcherContext {
  homeName?: string;
  awayName?: string;
}

/**
 * SET-PIECE MARKETS DISABLED. This watcher ONLY opens real-time MOMENT markets — goal-from-
 * corner / free-kick, penalty, VAR — which don't work on the ~40s-delayed ESPN feed: the
 * moment has already happened by the time the market opens, so the wallclock guard voids them.
 * Disabled until a near-real-time data feed exists. Flip to true to re-enable. (Open-play
 * volume — momentum/window, counts, which-side, period — comes from other openers, unaffected.)
 */
const SET_PIECES_ENABLED = false;

/**
 * Decide whether to open a market for the LATEST event, given recent context.
 * Set-piece → open it from rules (no LLM); anything else → null. Open-play volume
 * now comes from the momentum path, not from here.
 */
export async function aiTriggerFromEvents(
  recentEvents: FeedEvent[],
  game: GameState,
  ctx: AiWatcherContext = {},
): Promise<MarketTrigger | null> {
  const latest = recentEvents[recentEvents.length - 1];
  if (!latest) return null;
  // Set-piece / VAR moment markets are off on the delayed feed — see SET_PIECES_ENABLED.
  if (!SET_PIECES_ENABLED) return null;

  const knob = knobFor(latest.type);
  if (!knob) return null; // ignore — not an openable moment

  // CONTEXT-AWARE betting window: stretch it in the tense, late, extra-time moments.
  // BET_WINDOW_MS_OVERRIDE (ops/demo knob, 0/unset = off) forces a fixed base window.
  const baseWindow = Number(process.env.BET_WINDOW_MS_OVERRIDE) || knob.betWindowMs;
  const windowMs = confidenceWindowMs(baseWindow, 0.9, game);

  const ruleTrigger = triggerFromEvent(latest, {
    ...(ctx.homeName !== undefined ? { homeName: ctx.homeName } : {}),
    ...(ctx.awayName !== undefined ? { awayName: ctx.awayName } : {}),
  });

  // Post-shot ESPN lines ("Attempt saved…") must never open — play is over.
  if (isPostShotCommentary(latest.text)) {
    console.log(
      `[golazo/feed] watcher_skip_post_shot type=${latest.type} text="${latest.text.slice(0, 60)}"`,
    );
    return null;
  }

  // Defensive / own-half free kicks are never a goal chance — skip.
  if (latest.type === 'free_kick' && isDefensiveSetPiece(latest.text)) {
    console.log(`[golazo/feed] watcher_skip_defensive_fk text="${latest.text.slice(0, 60)}"`);
    return null;
  }

  if (!ruleTrigger) return null;

  // Never open a team-bound market without a team (no "They …").
  if (!ruleTrigger.team && requiresTeam(ruleTrigger.kind)) return null;

  console.log(
    `[golazo/feed] watcher_open_rules type=${latest.type} source=${String(latest.meta?.source)}`,
  );
  return { ...ruleTrigger, windowMs };
}

// Keep `Team` re-exported for callers/tests.
export type { Team };
