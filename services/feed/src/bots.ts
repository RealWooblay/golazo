/**
 * Simulated bettors.
 *
 * WHY: a fresh parimutuel market with only the house seed feels dead — the very
 * first human bettor stares at static odds. Bots trickle real `engine.placeBet`
 * calls across the betting window so the pool moves, odds drift, and the market
 * feels alive "from bet one". They use the SAME placeBet path the user does, so
 * the pool math and broadcasts are exercised identically.
 *
 * BEHAVIOUR: each bot leans toward `market.trueProb` (the model's YES estimate)
 * with per-bot noise, so the crowd roughly — but not exactly — prices the moment.
 * Bets are spread over the window with jitter, not dumped at open, so updates
 * stream out steadily. All timers are cancelled when the market locks/resolves.
 */

import type { MarketEngine, Market, Side } from '@golazo/core';

export interface BotConfig {
  /** Number of bots that will bet on each market. */
  count: number;
  /** Min/max stake per bot bet. */
  minStake?: number;
  maxStake?: number;
  /** RNG, injectable for deterministic tests. */
  rng?: () => number;
}

/**
 * Drives bot betting for a single market's open window. One instance per market;
 * call `cancel()` when the market locks/resolves to stop any pending bets.
 */
export class BotSwarm {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private cancelled = false;

  constructor(
    private readonly engine: MarketEngine,
    private readonly cfg: Required<BotConfig>,
  ) {}

  /** Schedule `count` bot bets, jittered across the market's betting window. */
  start(market: Market): void {
    // Leave a small guard before lock so a bet never races the lock and throws.
    const window = Math.max(500, market.windowMs - 400);

    for (let i = 0; i < this.cfg.count; i++) {
      const delay = Math.floor(this.cfg.rng() * window);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.placeOne(market.id, market.trueProb);
      }, delay);
      this.timers.add(timer);
    }
  }

  /** Cancel all pending bot bets (called on lock/resolve). */
  cancel(): void {
    this.cancelled = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Place a single bot bet, leaning toward trueProb with noise. */
  private placeOne(marketId: string, trueProb: number): void {
    if (this.cancelled) return;

    // Market may have locked between scheduling and firing — placeBet throws if
    // it's no longer open, which is fine to swallow for a bot.
    const m = this.engine.get(marketId);
    if (!m || m.status !== 'open') return;

    // Bot's private belief = trueProb nudged by noise in [-0.18, +0.18].
    const belief = clamp(trueProb + (this.cfg.rng() - 0.5) * 0.36, 0.02, 0.98);
    // Bet the side the bot believes is UNDERvalued vs the current pool. If the
    // pool's implied YES prob is below the bot's belief, YES looks cheap.
    const impliedYes = this.engine.odds(marketId).prob;
    const side: Side = belief > impliedYes ? 'YES' : 'NO';

    const stake =
      this.cfg.minStake +
      Math.floor(this.cfg.rng() * (this.cfg.maxStake - this.cfg.minStake + 1));

    try {
      this.engine.placeBet(marketId, this.botId(), side, stake);
    } catch {
      // Locked/resolved in the gap — ignore.
    }
  }

  private botId(): string {
    return `bot_${Math.floor(this.cfg.rng() * 1e6).toString(36)}`;
  }
}

/** Fill in defaults so the swarm always has concrete numbers. */
export function resolveBotConfig(cfg: BotConfig): Required<BotConfig> {
  return {
    count: cfg.count,
    minStake: cfg.minStake ?? 5,
    maxStake: cfg.maxStake ?? 50,
    rng: cfg.rng ?? Math.random,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
