/** Shared on-chain bet view-models (used by match + friends chain flows). */

export interface ChainBetVM {
  marketSeed: number;
  authority: string;
  /** off-chain market id this bet belongs to — used to detect resolution. */
  offChainMarketId: string;
  question: string;
  side: "YES" | "NO";
  /** stake in USX (human units; mint is 6dp) — the on-chain bet amount. */
  stakeUsd: number;
  estimatedMultiple: number;
  betSignature: string;
  betUrl: string;
  /** True once the off-chain market has resolved → the on-chain bet can claim. */
  claimable: boolean;
  resolvedOutcome?: "YES" | "NO" | "VOID";
  won?: boolean;
  /** Exact payout in USX (human units) once resolved — computed from the final on-chain pools.
   *  Win row shows realizedUsd − stake; VOID = stake (refund). Absent until resolved. */
  realizedUsd?: number;
  claiming: boolean;
  claimSignature?: string;
  claimUrl?: string;
}

/** Live indicative odds read from the on-chain pool. */
export interface ChainOdds {
  oddsYes: number;
  oddsNo: number;
  yesShare: number;
  /** total pooled stake in USX (human units). */
  poolUsd: number;
}

/** Cached on-chain pool — odds are derived synchronously from this + stake. */
export interface ChainPoolCache {
  poolYesLamports: bigint;
  poolNoLamports: bigint;
  rakeBps: number;
}
