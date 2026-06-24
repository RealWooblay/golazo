/**
 * Shared config + helpers for the liquidity-simulation swarms.
 *
 * These bots are a LOCAL liveliness/load-testing aid only. They are DISABLED by
 * default (see `config.liquidityBotsEnabled`) and never run in the on-chain-faithful
 * points/real simulation, where the parimutuel multiple must move on REAL aggregate
 * user money — not synthetic house liquidity.
 */
export interface BotConfig {
  /** Number of bots that will bet on each market. */
  count: number;
  /** Min/max stake per bot bet. */
  minStake?: number;
  maxStake?: number;
  /** RNG, injectable for deterministic tests. */
  rng?: () => number;
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

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
