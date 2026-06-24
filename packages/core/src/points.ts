/**
 * POINTS — server-authoritative fake-currency skill score on the live feed.
 *
 * Points are a SINGLE per-user balance that spans BOTH modes — one universal
 * leaderboard for everyone:
 *   • PAPER bets move points through their own zero-rake parimutuel pool.
 *   • REAL bets ALSO move the bettor's points by their net result (win → +,
 *     lose → −), so you earn/burn points on every settled bet, win or lose.
 * Real $ stays separate; points are the cross-mode score everyone competes on.
 */
import type { Outcome, Side } from './types';
import type { MarketStatus } from './engine';
import type { Payout } from './parimutuel';
import { settle, type Pool, type Settlement } from './parimutuel';

/** Starting tab for a new points player. */
export const POINTS_START_BALANCE = 500;
/** Minimum balance before a free top-up is offered. */
export const POINTS_REFILL_THRESHOLD = 50;
/** Cooldown between paper-trade refills (ms). */
export const POINTS_REFILL_COOLDOWN_MS = 60_000;
/** No rake in paper mode — winners split the full pool. */
export const POINTS_RAKE = 0;

export interface PointsPlayer {
  userId: string;
  name: string;
  balance: number;
  connected: boolean;
  joinedAt: number;
}

export interface PointsBet {
  userId: string;
  side: Side;
  stake: number;
}

export interface PointsMarket {
  id: string;
  status: MarketStatus;
  pool: Pool;
  openedAt: number;
  lockAt: number;
  windowMs: number;
  bets: PointsBet[];
  outcome?: Outcome;
}

/** Live pool snapshot pushed to clients for indicative odds. */
export interface PointsMarketSnapshot {
  marketId: string;
  poolYes: number;
  poolNo: number;
  oddsYes: number;
  oddsNo: number;
  yesShare: number;
  participants: number;
}

export function settlePointsMarket(market: PointsMarket, outcome: Outcome): Settlement {
  // ONE-SIDED RULE (no auto-VOID). If you back a side with no opponent:
  //   • you WIN  → your stake straight back (1.0x — there's nothing to win FROM), and
  //   • you're WRONG → you forfeit the stake (it's lost; the house keeps the unmatched money).
  // Only an EXPLICIT market-level VOID (full-time cut-short, anti-arb taint, match switch)
  // refunds — a normal YES/NO settle never refunds a loser just because they were alone.
  return settle(market.pool, market.bets, outcome, POINTS_RAKE);
}

/**
 * Points delta a REAL bet contributes to the bettor's cross-mode score.
 * 1 point ≈ $1: net result (payout − stake), rounded. Wins add, losses burn;
 * a VOID refund is net-zero. This is how real-mode bets feed the same leaderboard
 * as paper bets without touching the real-money pool.
 */
export function realBetPointsDelta(payout: Payout): number {
  return Math.round(payout.payout - payout.stake);
}

export function snapshotPointsMarket(market: PointsMarket): PointsMarketSnapshot {
  const yes = market.pool.yes;
  const no = market.pool.no;
  const gross = yes + no;
  const net = gross * (1 - POINTS_RAKE);
  const participants = new Set(market.bets.map((b) => b.userId)).size;
  return {
    marketId: market.id,
    poolYes: yes,
    poolNo: no,
    oddsYes: yes > 0 ? net / yes : 1,
    oddsNo: no > 0 ? net / no : 1,
    yesShare: gross > 0 ? (100 * yes) / gross : 50,
    participants,
  };
}
