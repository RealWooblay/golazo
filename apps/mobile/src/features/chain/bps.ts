/**
 * BPS PARIMUTUEL MATH — TypeScript mirror of the on-chain integer math.
 *
 * Quotes are indicative only: final claim payout is computed from the final
 * winning-side pool after betting closes.
 */

import type { OnChainSide } from "./types";

/** 10_000 bps == 100% == 1.0 — mirrors `state::BPS_DENOMINATOR`. */
export const BPS_DENOMINATOR = 10_000n;

/** gross = pool_yes + pool_no. Mirrors `Market::gross()`. */
export function gross(poolYes: bigint, poolNo: bigint): bigint {
  return poolYes + poolNo;
}

/**
 * net = gross * (10_000 - rake_bps) / 10_000. Mirrors `Market::net()`.
 * `rakeBps` must be < 10_000 (the program enforces this at init).
 */
export function net(poolYes: bigint, poolNo: bigint, rakeBps: number): bigint {
  const keepBps = BPS_DENOMINATOR - BigInt(rakeBps);
  return (gross(poolYes, poolNo) * keepBps) / BPS_DENOMINATOR;
}

export function poolAfterBet(
  poolYes: bigint,
  poolNo: bigint,
  side: OnChainSide,
  stakeLamports: bigint,
): { yes: bigint; no: bigint } {
  return side === "Yes"
    ? { yes: poolYes + stakeLamports, no: poolNo }
    : { yes: poolYes, no: poolNo + stakeLamports };
}

/** Estimated payout if this bet lands and no further money arrives. */
export function indicativePayout(
  poolYes: bigint,
  poolNo: bigint,
  rakeBps: number,
  side: OnChainSide,
  stakeLamports: bigint,
): bigint {
  if (stakeLamports <= 0n) return 0n;
  const after = poolAfterBet(poolYes, poolNo, side, stakeLamports);
  const winningPool = side === "Yes" ? after.yes : after.no;
  const losingPool = side === "Yes" ? after.no : after.yes;
  if (winningPool <= 0n) return 0n;
  // One-sided book (no opposing stake) → nothing to win FROM and no rake to take, so it settles
  // as a 1.0x refund. Quote 1.0x, never the sub-1.0x stake*(1-rake) that applying rake to an empty
  // book produced ("$1 @ est. 0.94x" on a market that then voids + refunds in full).
  if (losingPool <= 0n) return stakeLamports;
  return (stakeLamports * net(after.yes, after.no, rakeBps)) / winningPool;
}

/** Estimated payout multiple in bps, or 0 when stake is zero. */
export function indicativeMultipleBps(
  poolYes: bigint,
  poolNo: bigint,
  rakeBps: number,
  side: OnChainSide,
  stakeLamports: bigint,
): bigint {
  if (stakeLamports <= 0n) return 0n;
  return (indicativePayout(poolYes, poolNo, rakeBps, side, stakeLamports) *
    BPS_DENOMINATOR) /
    stakeLamports;
}

/** bps → a human decimal multiple (e.g. 19400n → 1.94). Display only. */
export function bpsToMultiple(bps: bigint): number {
  return Number(bps) / Number(BPS_DENOMINATOR);
}

/** A decimal multiple → bps (e.g. 1.94 → 19400n). Display/round-trip only. */
export function multipleToBps(multiple: number): bigint {
  return BigInt(Math.round(multiple * Number(BPS_DENOMINATOR)));
}
