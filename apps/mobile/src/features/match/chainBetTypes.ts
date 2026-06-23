/** Shared on-chain bet view-models (used by match + friends chain flows). */

export interface ChainBetVM {
  marketSeed: number;
  authority: string;
  /** off-chain market id this bet belongs to — used to detect resolution. */
  offChainMarketId: string;
  question: string;
  side: "YES" | "NO";
  stakeSol: number;
  estimatedMultiple: number;
  betSignature: string;
  betUrl: string;
  /** True once the off-chain market has resolved → the on-chain bet can claim. */
  claimable: boolean;
  resolvedOutcome?: "YES" | "NO" | "VOID";
  won?: boolean;
  claiming: boolean;
  claimSignature?: string;
  claimUrl?: string;
}

/** Live indicative odds read from the on-chain pool. */
export interface ChainOdds {
  oddsYes: number;
  oddsNo: number;
  yesShare: number;
  poolSol: number;
}
