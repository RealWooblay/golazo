import type { FeedEvent, GameState } from '@golazo/core';
import { feedLagMinutes } from '../ai/marketTuning';

/** Max acceptable ESPN wall-clock lag before VOIDing open markets (seconds). */
export const MAX_WALLCLOCK_LAG_SEC = 90;

/** Max match-clock lag (minutes) before refusing to open. */
export const MAX_OPEN_LAG_MIN = 1.5;

/**
 * Track feed freshness from ESPN wallclock + match clock.
 * Wallclock is the best signal for "this event is stale in real life".
 */
export class LagMeter {
  private lastWallclockLagSec: number | null = null;
  private lastClockLagMin = 0;

  observe(ev: FeedEvent, game: GameState): void {
    this.lastClockLagMin = feedLagMinutes(ev, game);
    const wc = ev.meta?.wallclock;
    if (typeof wc === 'string') {
      const reported = Date.parse(wc);
      if (Number.isFinite(reported)) {
        this.lastWallclockLagSec = Math.max(0, (Date.now() - reported) / 1000);
      }
    }
  }

  clockLagMin(): number {
    return this.lastClockLagMin;
  }

  wallclockLagSec(): number | null {
    return this.lastWallclockLagSec;
  }

  /** True when ESPN's wallclock says this play is too old to bet fairly. */
  isWallclockStale(): boolean {
    return this.lastWallclockLagSec !== null && this.lastWallclockLagSec > MAX_WALLCLOCK_LAG_SEC;
  }

  /** True when match-clock stamp is too far behind live scoreboard. */
  isClockStale(): boolean {
    return this.lastClockLagMin > MAX_OPEN_LAG_MIN;
  }
}
