/**
 * Liquidity-simulation bots — DISABLED by default (`config.liquidityBotsEnabled`).
 *
 * Kept here, isolated from the orchestrator/points/engine, purely as a local
 * liveliness + load-testing aid. They are NEVER part of the on-chain-faithful
 * simulation: on-chain, liquidity is real users, so the points/real parimutuel
 * multiple must move only on real, aggregated user money. Enable with
 * `LIQUIDITY_BOTS=1` for local testing.
 */
export { BotSwarm } from './botSwarm';
export { PointsBotSwarm, type PointsLiquiditySink } from './pointsBotSwarm';
export { resolveBotConfig, type BotConfig } from './config';
