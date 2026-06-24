/**
 * POINTS-pool liquidity bots.
 *
 * Same shape as `BotSwarm`, but bets PAPER points on BOTH sides — leaning to
 * whichever side the pool currently UNDERvalues vs `trueProb` — so a points
 * market's multiple drifts to something meaningful instead of being pinned near
 * ~1.1x by the fixed seed alone. Each bet's marketUpdate is broadcast via `emit`
 * so clients watch the odds move live. Bots have no balance; they're tracked as
 * `pbot_*` and never paid.
 *
 * DISABLED by default. On-chain there is no such thing — real liquidity is real
 * users. The points simulation must mirror that (the multiple moves on real,
 * aggregate user money), so these only run as a local liveliness/load aid.
 * See `bots/config.ts`.
 */
import type { Market, Side } from '@golazo/core';
import { bettingSafetyBufferMs } from '../ai/marketTuning';
import type { PointsEffects } from '../points';
import { clamp, type BotConfig } from './config';

/** The slice of PointsManager the points swarm needs (decoupled for tests). */
export interface PointsLiquiditySink {
  marketImpliedYes(marketId: string): number | undefined;
  placeBotBet(marketId: string, side: Side, stake: number): PointsEffects;
}

export class PointsBotSwarm {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private cancelled = false;

  constructor(
    private readonly points: PointsLiquiditySink,
    private readonly emit: (fx: PointsEffects) => void,
    private readonly cfg: Required<BotConfig>,
  ) {}

  start(market: Market): void {
    const window = Math.max(1000, market.windowMs - bettingSafetyBufferMs(market.windowMs) - 500);
    for (let i = 0; i < this.cfg.count; i++) {
      const delay = Math.floor(this.cfg.rng() * window);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.placeOne(market.id, market.trueProb);
      }, delay);
      this.timers.add(timer);
    }
  }

  cancel(): void {
    this.cancelled = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private placeOne(marketId: string, trueProb: number): void {
    if (this.cancelled) return;
    const impliedYes = this.points.marketImpliedYes(marketId);
    if (impliedYes === undefined) return; // market gone / closed
    const belief = clamp(trueProb + (this.cfg.rng() - 0.5) * 0.36, 0.02, 0.98);
    const side: Side = belief > impliedYes ? 'YES' : 'NO';
    const stake =
      this.cfg.minStake + Math.floor(this.cfg.rng() * (this.cfg.maxStake - this.cfg.minStake + 1));
    const fx = this.points.placeBotBet(marketId, side, stake);
    if (fx.marketUpdate) this.emit(fx);
  }
}
