import type { Outcome, Side } from './types';

/**
 * Pure parimutuel pool math.
 *
 * There is no house-backed fixed payout. All stakes form one pool, the operator
 * takes rake from the gross pool, and winners split the remaining pool by final
 * winning-side share. Odds shown before settlement are indicative only.
 */

/** A pool holds total user stake on each side. */
export interface Pool {
  yes: number;
  no: number;
}

export const grossPool = (p: Pool): number => p.yes + p.no;
export const netPool = (p: Pool, rake: number): number => grossPool(p) * (1 - rake);

/** Implied YES probability from final/current stake distribution. */
export function impliedProb(p: Pool): number {
  const g = grossPool(p);
  return g > 0 ? p.yes / g : 0.5;
}

/**
 * Current indicative multiple for each side from the pool as-is.
 *
 * If no one has backed a side yet its as-is multiple is undefined; return 1 so
 * the UI stays finite. Stake-aware quotes should use `indicativeQuote`.
 */
export function impliedOdds(p: Pool, rake: number): { yes: number; no: number } {
  const net = netPool(p, rake);
  return {
    yes: p.yes > 0 ? net / p.yes : 1,
    no: p.no > 0 ? net / p.no : 1,
  };
}

/** Pool after hypothetically adding `stake` to `side`. */
export function poolAfterBet(p: Pool, side: Side, stake: number): Pool {
  return side === 'YES'
    ? { yes: p.yes + stake, no: p.no }
    : { yes: p.yes, no: p.no + stake };
}

/**
 * Estimated payout/multiple if this bet lands now and no more money arrives.
 * This is a preview, not a guarantee.
 */
export function indicativeQuote(
  p: Pool,
  side: Side,
  stake: number,
  rake: number,
): { payout: number; multiple: number } {
  if (stake <= 0) return { payout: 0, multiple: 0 };
  const after = poolAfterBet(p, side, stake);
  const winningPool = side === 'YES' ? after.yes : after.no;
  const losingPool = side === 'YES' ? after.no : after.yes;
  if (winningPool <= 0) return { payout: 0, multiple: 0 };
  // No opposing stake → one-sided: this would settle as a 1.0x refund (no counter-pool to win
  // from or rake). Quote 1.0x, never the sub-1.0x "win" that applying rake to an empty book gave.
  if (losingPool <= 0) return { payout: stake, multiple: 1 };
  const payout = (stake / winningPool) * netPool(after, rake);
  return { payout, multiple: payout / stake };
}

export interface Bet {
  userId: string;
  side: Side;
  stake: number;
}

export interface Payout {
  userId: string;
  side: Side;
  stake: number;
  payout: number;
  won: boolean;
}

export interface Settlement {
  outcome: Outcome;
  rakeTaken: number;
  distributable: number; // gross - rake
  totalPayouts: number;
  /** House revenue/residual retained by the market. In normal two-sided books this is the rake. */
  operatorPnl: number;
  payouts: Payout[];
}

/**
 * Settle a market against the final outcome.
 *  - VOID refunds every stake, no rake.
 *  - YES/NO winners split `gross - rake` by final winning-side share.
 */
export function settle(
  p: Pool,
  bets: Bet[],
  outcome: Outcome,
  rake: number,
  seedAmount = 0,
): Settlement {
  if (outcome === 'VOID') {
    return {
      outcome,
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: bets.map((b) => ({
        userId: b.userId,
        side: b.side,
        stake: b.stake,
        payout: b.stake,
        won: false,
      })),
    };
  }

  const gross = grossPool(p);
  const winningPool = outcome === 'YES' ? p.yes : p.no;
  const losingPool = outcome === 'YES' ? p.no : p.yes;
  // Rake only makes sense when there's a LOSING counter-pool to take it from. With no losing
  // stake (a one-sided winning book) take NO rake — otherwise a winner is paid stake*(1-rake)
  // and loses ~6% of their OWN money (the bug). Note: a one-sided LOSS — everyone backed the
  // side that LOST — is NOT a refund; those bettors still forfeit (being the only side ≠ a void).
  const rakeTaken = losingPool > 0 ? gross * rake : 0;
  const distributable = gross - rakeTaken;

  const payouts: Payout[] = bets.map((b) => {
    const won = b.side === outcome;
    return {
      userId: b.userId,
      side: b.side,
      stake: b.stake,
      // Winner: split the distributable pool by stake share. A one-sided winner (no losing
      // counter-pool) has nothing to win FROM, so they just get their stake back (1.0x) — never 0,
      // never stake*(1-rake).
      payout: won ? (losingPool > 0 ? (b.stake / winningPool) * distributable : b.stake) : 0,
      won,
    };
  });

  const totalPayouts = payouts.reduce((s, x) => s + x.payout, 0);
  return {
    outcome,
    rakeTaken,
    distributable,
    totalPayouts,
    operatorPnl: gross - totalPayouts - seedAmount,
    payouts,
  };
}
