/**
 * Sim feed adapter — wraps the core `SimMatch` as a `FeedSource`.
 *
 * WHY this exists: `SimMatch` already emits the exact normalized `FeedEvent`
 * stream a real provider would (attacks followed by a resolving goal/miss, with
 * a `meta.sequenceId` correlating them). All this adapter does is drive it on a
 * wall-clock tick and surface its `GameState` — so the orchestrator can consume
 * sim and ESPN through one identical interface and never know the difference.
 *
 * This is also the universal fallback: no API key, no network, no live game —
 * the service still runs a full, lifelike match on this.
 */

import { SimMatch, type FeedEvent, type GameState, type Rng } from '@golazo/core';
import type { FeedSource } from './index';

export interface SimFeedOptions {
  /** Injectable RNG for deterministic runs/tests. Defaults to Math.random. */
  rng?: Rng;
  /** Wall-clock origin for the match timeline. Defaults to now. */
  startAt?: number;
}

/**
 * A `FeedSource` backed by the deterministic match simulator.
 *
 * The sim is purely time-driven: we hold a `start` epoch and translate each
 * `poll()` into "simulator time = now - start". The simulator's `due()` pops
 * every event whose scheduled time has arrived, so polling faster just means we
 * notice events sooner — it never changes WHAT happens.
 */
export class SimFeed implements FeedSource {
  readonly kind = 'sim' as const;
  private readonly sim: SimMatch;
  private readonly start: number;

  constructor(opts: SimFeedOptions = {}) {
    this.start = opts.startAt ?? Date.now();
    // Anchor the sim timeline at 0 so its internal scheduling math is simple;
    // we map wall-clock -> sim-time in poll().
    this.sim = new SimMatch({ startAt: 0, ...(opts.rng ? { rng: opts.rng } : {}) });
  }

  /** Current normalized game state (teams, score, clock, status). */
  state(): GameState {
    return this.sim.state;
  }

  /** Pull any events whose scheduled time has now arrived. */
  poll(now: number = Date.now()): FeedEvent[] {
    return this.sim.due(now - this.start);
  }

  /**
   * Reflect a goal back into the simulator's scoreline. The orchestrator owns
   * the decision of WHEN to apply a goal (on the resolving `goal` event), so we
   * expose this passthrough rather than have the sim mutate itself.
   */
  applyGoal(team: 'home' | 'away'): void {
    this.sim.applyGoal(team);
  }

  /** Update the display clock (the host drives the clock; sim stays simple). */
  setClock(clock: string): void {
    this.sim.setClock(clock);
  }

  /** Sim never needs teardown, but the interface asks for it for symmetry. */
  async close(): Promise<void> {
    /* no-op */
  }
}
