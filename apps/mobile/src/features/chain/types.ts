/**
 * CHAIN FEATURE TYPES — light, dependency-free type-only surface.
 *
 * These intentionally do NOT import `@solana/web3.js` or `@coral-xyz/anchor`, so
 * any module (including UI, the hook's eager path, and tests) can import them
 * without dragging in the heavy chain libs. Where a Solana type is genuinely
 * needed at the value layer it is referenced via `string` (base58) at this
 * boundary and converted to a `PublicKey` only inside the lazily-loaded client.
 *
 * Enum string unions here mirror the program's Anchor enums exactly:
 *   Side          → 'Yes' | 'No'
 *   Outcome       → 'None' | 'Yes' | 'No'
 *   MarketStatus  → 'Open' | 'Locked' | 'Resolved' | 'Void'
 *
 * Note these are the ON-CHAIN spellings (capitalized). The app's own domain
 * types (`@golazo/core`) use 'YES'/'NO'/'VOID'; `index.ts` exposes adapters so
 * callers can pass either and we map at the boundary.
 */

/** On-chain side spelling (matches the Rust `Side` enum). */
export type OnChainSide = "Yes" | "No";

/** On-chain settled outcome (matches the Rust `Outcome` enum). */
export type OnChainOutcome = "None" | "Yes" | "No";

/** On-chain market lifecycle (matches the Rust `MarketStatus` enum). */
export type OnChainMarketStatus = "Open" | "Locked" | "Resolved" | "Void";

/** Decoded `Market` account, lamports/seeds as `bigint` (mirrors u64). */
export interface MarketAccount {
  /** base58 address of the market PDA. */
  address: string;
  authority: string;
  marketSeed: bigint;
  /** 32-byte question hash, hex-encoded for portability. */
  questionHashHex: string;
  rakeBps: number;
  status: OnChainMarketStatus;
  outcome: OnChainOutcome;
  poolYesLamports: bigint;
  poolNoLamports: bigint;
  seedYesLamports: bigint;
  seedNoLamports: bigint;
  vaultBump: number;
  bump: number;
}

/** Decoded `Bet` account. */
export interface BetAccount {
  /** base58 address of the bet PDA. */
  address: string;
  market: string;
  bettor: string;
  side: OnChainSide;
  stakeLamports: bigint;
  claimed: boolean;
  bump: number;
}

/** The set of PDAs for a given (authority, marketSeed). All base58 strings. */
export interface MarketPdas {
  market: string;
  vault: string;
  /** Present only when a bettor is supplied (per-(market,bettor) bet PDA). */
  bet?: string;
}

/** Result of submitting a transaction. */
export interface TxResult {
  signature: string;
  /** Cluster-aware explorer URL for the signature (handy for receipts/links). */
  explorerUrl: string;
}

/** Snapshot of the embedded wallet for UI. Never exposes the secret key. */
export interface WalletInfo {
  address: string;
  balanceSol: number;
  balanceLamports: bigint;
}

/** Indicative preview of a bet, computed via the bps mirror. */
export interface BetQuote {
  side: OnChainSide;
  stakeLamports: bigint;
  /** Non-guaranteed estimated multiple in bps. */
  estimatedMultBps: bigint;
  /** Same estimated multiple as a decimal (1.94…) for display. */
  estimatedMultiple: number;
  /** Floored estimated payout in lamports if no more money arrives. */
  estimatedPayoutLamports: bigint;
}

/** Args to place a bet on-chain. */
export interface PlaceBetArgs {
  authority: string; // market authority (part of the market PDA seeds)
  marketSeed: bigint | number;
  side: OnChainSide;
  stakeLamports: bigint | number;
}

/** Args to claim a settled bet. */
export interface ClaimArgs {
  authority: string;
  marketSeed: bigint | number;
}
