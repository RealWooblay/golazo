// Mode-aware wallet balance for the app chrome (lobby/match/profile headers).
//
// The app speaks DOLLARS everywhere. When the embedded on-chain wallet is
// connected (Live/chain mode), the number shown is the REAL on-chain balance
// converted to $ (via SOL_PER_UNIT). Otherwise it's the play-money store balance,
// also in $. One hook so no header can drift between units or show raw SOL.
import { useChain } from "./useChain";
import { useStore } from "@/state/store";
import { money, pts } from "@/lib/format";

/** Display conversion: one $ "unit" of stake/balance = this much SOL on-chain.
 *  $1 = 0.01 SOL. Used both to turn the real SOL balance into the $ figure we
 *  show and to size on-chain stakes from the $ chips. */
export const SOL_PER_UNIT = 0.01;

export interface DisplayBalance {
  /** True when the figure is backed by the real on-chain balance (vs play money). */
  chain: boolean;
  /** Play-mode points (server authoritative, separate from real bettors). */
  points: boolean;
  /** The dollar balance to render. */
  amount: number;
  /** Formatter ($, pts, or SOL-backed $). */
  format: (n: number) => string;
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
      balanceInUnits: store.pointsBalance,
    };
  }
  // REAL balance only in live mode with a connected wallet. A DEMO game (offline
  // mode, loaded from the Demo button) is always play money. Either way we render
  // DOLLARS — the on-chain SOL balance is converted to $ via SOL_PER_UNIT.
  if (chain.ready && store.mode === "live") {
    const dollars = chain.balanceSol / SOL_PER_UNIT;
    return {
      chain: true,
      points: false,
      amount: dollars,
      format: money,
      balanceInUnits: dollars,
    };
  }
  return {
    chain: false,
    points: false,
    amount: store.balance,
    format: money,
    balanceInUnits: store.balance,
  };
}

/** Format a stake (held in "units") for display — POINTS in paper mode, dollars
 *  otherwise. Pass `bal.points` so the card's stake / pool / odds match the
 *  header's currency (was always `$`, which made paper mode read as money). */
export function makeStakeFormatter(points: boolean): (units: number) => string {
  return points ? pts : money;
}
