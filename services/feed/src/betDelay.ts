import { bettingClosesAt } from './ai/marketTuning';

/** Minimal market shape for bet-window checks (global engine or room market). */
export interface BetWindowMarket {
  status: string;
  lockAt: number;
  windowMs: number;
}

/**
 * Whether a bet may still be accepted at `now`. Used by the orchestrator hold
 * path and room-bet delay so off-chain and friends pools share one rule.
 */
export function canAcceptBetNow(market: BetWindowMarket | undefined, now: number): boolean {
  if (!market || market.status !== 'open') return false;
  return now < bettingClosesAt(market.lockAt, market.windowMs);
}
