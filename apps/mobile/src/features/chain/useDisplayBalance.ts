// Mode-aware wallet balance for the app chrome (lobby/match/profile headers).
//
// The app speaks DOLLARS everywhere. When the embedded on-chain wallet is
// connected (Live/chain mode), the number shown is the REAL on-chain USX balance
// (USX is the settlement asset; 1 USX == $1, shown directly). Otherwise it's the
// play-money store balance, also in $. One hook so no header can drift between units.
import { useChain } from "./useChain";
import { useStore } from "@/state/store";
import { money, pts, signedMoney, signedPts } from "@/lib/format";

export interface DisplayBalance {
  /** True when the figure is backed by the real on-chain balance (vs play money). */
  chain: boolean;
  /** Play-mode points (server authoritative, separate from real bettors). */
  points: boolean;
  /** The dollar balance to render. */
  amount: number;
  /** Formatter ($, pts, or SOL-backed $). */
  format: (n: number) => string;
  /** Signed delta formatter (+$25 / +25 pts). */
  signedFormat: (n: number) => string;
  /** Zero-delta label for void/refund rows ($0 / 0 pts). */
  zeroLabel: string;
  /** Balance in $ "units" for over-balance checks (same as `amount`). */
  balanceInUnits: number;
}

export function useDisplayBalance(): DisplayBalance {
  const chain = useChain();
  const store = useStore();
  if (store.session.moneyMode === "points") {
    return {
      chain: false,
      points: true,
      amount: store.pointsBalance,
      format: pts,
      signedFormat: signedPts,
      zeroLabel: "0 pts",
      balanceInUnits: store.pointsBalance,
    };
  }
  // REAL balance only in live mode with a connected wallet. A DEMO game (offline
  // mode, loaded from the Demo button) is always play money. The on-chain balance
  // is USX, shown directly as dollars (1 USX == $1).
  if (chain.ready && store.mode === "live") {
    const dollars = chain.balanceUsd;
    return {
      chain: true,
      points: false,
      amount: dollars,
      format: money,
      signedFormat: signedMoney,
      zeroLabel: "$0",
      balanceInUnits: dollars,
    };
  }
  return {
    chain: false,
    points: false,
    amount: store.balance,
    format: money,
    signedFormat: signedMoney,
    zeroLabel: "$0",
    balanceInUnits: store.balance,
  };
}

/** Format a stake (held in "units") for display — POINTS in paper mode, dollars
 *  otherwise. Pass `bal.points` so the card's stake / pool / odds match the
 *  header's currency (was always `$`, which made paper mode read as money). */
export function makeStakeFormatter(points: boolean): (units: number) => string {
  return points ? pts : money;
}

/** Signed delta formatter — matches {@link makeStakeFormatter} for history rows. */
export function makeSignedFormatter(points: boolean): (n: number) => string {
  return points ? signedPts : signedMoney;
}
