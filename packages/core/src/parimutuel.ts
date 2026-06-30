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
  const gross = grossPool(p);
  // VOID — or a ONE-SIDED book (all stake on a single side) — refunds every stake at 1.0x and
  // takes no rake, reported as VOID. A one-sided book is no genuine two-way contest: a "winner"
  // has nothing to win FROM (paying stake*(1-rake) would cost them ~6% of their OWN money) and a
  // "loser" had no real opponent (forfeiting would hand the house a no-contest pool). Refunding
  // BOTH keeps the off-chain settlement consistent with the operator's on-chain isOneSidedRealBook
  // void — so the app's P&L, the cross-mode points score, and the real USX wallet all agree.
  const oneSided = gross > 0 && (p.yes <= 0 || p.no <= 0);
  if (outcome === 'VOID' || oneSided) {
    return {
      outcome: 'VOID',
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

  const rakeTaken = gross * rake;
  const distributable = gross - rakeTaken;
  const winningPool = outcome === 'YES' ? p.yes : p.no;

  const payouts: Payout[] = bets.map((b) => {
    const won = b.side === outcome;
    return {
      userId: b.userId,
      side: b.side,
      stake: b.stake,
      // Two-sided book: winners split the distributable pool by stake share. (One-sided books are
      // refunded above, so winningPool is always > 0 here.)
      payout: won ? (b.stake / winningPool) * distributable : 0,
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

/** One bettor's resolved result, derived from a settlement. */
export interface UserBetResult {
  /** True only when the bettor's side matched the outcome (NOT payout>stake). */
  won: boolean;
  /** Gross credit owed: full payout on a win, the stake back on VOID/refund, 0 on a loss. */
  payout: number;
  /** Signed net for P&L: payout−stake on a win, −stake on a loss, 0 on VOID/refund. */
  delta: number;
  /** False when the bettor isn't in payouts[] — the bet never entered the pool (anti-snipe
   *  delay / reject), so it's a refund (net 0), never a −stake loss. */
  inPool: boolean;
}

/**
 * Derive a single bettor's win/payout/net from a market settlement — the ONE place that
 * decides "what happened to my bet". Win is `side === outcome` (never payout>stake). A VOID,
 * or a bet that never made the pool, is a clean stake refund (net 0), not a loss.
 *
 * Shared by the client (reveal + session P&L) and the E2E money sim so they can never drift.
 */
export function userBetFromSettlement(
  settlement: Settlement,
  bettorId: string,
  stake: number,
  side: Side,
): UserBetResult {
  const mine = settlement.payouts.find((x) => x.userId === bettorId);
  if (settlement.outcome === 'VOID') {
    return { won: false, payout: stake, delta: 0, inPool: !!mine };
  }
  if (!mine) {
    return { won: false, payout: stake, delta: 0, inPool: false };
  }
  const won = side === settlement.outcome;
  return { won, payout: mine.payout, delta: won ? mine.payout - stake : -stake, inPool: true };
}
