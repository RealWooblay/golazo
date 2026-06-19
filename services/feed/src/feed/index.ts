/**
 * Feed abstraction + factory.
 *
 * The orchestrator talks to feeds ONLY through `FeedSource`, so it is identical
 * whether the events come from a real ESPN game or the deterministic simulator.
 * `createFeed()` decides which concrete adapter to hand back based on config and
 * live availability, with graceful degradation baked in:
 *
 *   FEED_MODE=sim   -> always SimFeed.
 *   FEED_MODE=espn  -> EspnFeed if a game is live, else EmptyFeed. NEVER the sim:
 *                      the live app must not surface the demo (demo = Profile only).
 *   FEED_MODE=auto  -> try EspnFeed; on any error or no-live-game, SimFeed (this is
 *                      the zero-config DEV convenience, not for the deployed app).
 */

import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { Config } from '../config';
import { SimFeed } from './sim';
import { EspnFeed } from './espn';
import { EspnReplayFeed } from './replay';
import { EmptyFeed } from './empty';

/**
 * The single interface every feed implements. `poll()` may be sync (sim) or
 * async (espn); callers always `await` it, which works for both.
 */
export interface FeedSource {
  /** Which concrete adapter this is — handy for logging/telemetry. */
  readonly kind: 'sim' | 'espn' | 'replay' | 'empty';

  /** Current normalized game state (teams, score, clock, status). */
  state(): GameState;

  /** Return any feed events that have become available since the last poll. */
  poll(now?: number): FeedEvent[] | Promise<FeedEvent[]>;

  /** Reflect a confirmed goal into the feed's scoreline (sim mutates; espn is a no-op). */
  applyGoal(team: Team): void;

  /** Set the display clock. */
  setClock(clock: string): void;

  /** Release any resources (network handles, timers). */
  close(): Promise<void>;
}

/** What the factory returns, so the caller can log which path it took. */
export interface CreatedFeed {
  feed: FeedSource;
  /** Human-readable reason for the choice, for the boot log. */
  reason: string;
}

/**
 * Pick a feed based on config + live availability. Always resolves to a working
 * feed — the sim is the universal fallback.
 */
export async function createFeed(config: Config): Promise<CreatedFeed> {
  if (config.feedMode === 'sim') {
    return { feed: new SimFeed({ startAt: Date.now() }), reason: 'FEED_MODE=sim' };
  }

  // REPLAY a real, finished match's play-by-play (real plays, real outcomes).
  if (config.feedMode === 'replay') {
    const replay = new EspnReplayFeed({ league: config.espnLeague, eventId: config.replayEventId });
    try {
      if (await replay.start()) {
        return { feed: replay, reason: `replaying real match ${config.replayEventId} (${config.espnLeague})` };
      }
      await replay.close();
    } catch (err) {
      await replay.close().catch(() => {});
      return {
        feed: new SimFeed({ startAt: Date.now() }),
        reason: `replay unavailable (${(err as Error).message}) — using sim`,
      };
    }
    return { feed: new SimFeed({ startAt: Date.now() }), reason: 'replay had no events — using sim' };
  }

  // 'espn' or 'auto' — both attempt the real feed first. The DIFFERENCE is the
  // fallback: 'espn' (the deployed/live app) falls back to EmptyFeed so the demo
  // NEVER shows; 'auto' (dev convenience) falls back to the sim.
  const strict = config.feedMode === 'espn';
  const fallback = (why: string): CreatedFeed =>
    strict
      ? { feed: new EmptyFeed(), reason: `${why} — no live match (FEED_MODE=espn, no demo)` }
      : { feed: new SimFeed({ startAt: Date.now() }), reason: `${why} — using sim` };

  const espn = new EspnFeed({ league: config.espnLeague });
  try {
    const live = await espn.start();
    if (live) {
      return { feed: espn, reason: `live ESPN game found (${config.espnLeague})` };
    }
    await espn.close();
    return fallback(`no live ESPN game in ${config.espnLeague}`);
  } catch (err) {
    await espn.close().catch(() => {});
    return fallback(`ESPN unavailable (${(err as Error).message})`);
  }
}
