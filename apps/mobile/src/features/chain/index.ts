/**
 * CHAIN FEATURE — public barrel.
 *
 * WEB-SAFETY CONTRACT (critical):
 *   This barrel re-exports ONLY the web-safe, lazy surface — the React hooks
 *   (`useChain`, `useChainDepositAddress`), the `ChainProvider`, the pure config,
 *   the pure bps math, the pure PDA-seed helpers, and TYPE-ONLY symbols.
 *
 *   It must NEVER statically re-export `./provider`, `./client`, or `./wallet` —
 *   those import `@solana/web3.js` / `@coral-xyz/anchor` / the keypair at module
 *   load, which would defeat the lazy gate and break the web bundle. Those
 *   modules are reached EXCLUSIVELY through the dynamic `import()`s inside
 *   `useChain().connect()`.
 *
 *   `./pdas` does import `@solana/web3.js` (it needs `PublicKey`), so it is also
 *   NOT re-exported here; callers who need raw PDA derivation get it via
 *   `useChain().derivePdas(...)` (lazy) instead.
 */

// ── React surface (lazy under the hood) ──────────────────────────────────────
export { ChainProvider, useChain } from "./useChain";
export type { UseChain, ChainStatus } from "./useChain";

// The deposit-address hook the wallet feature consumes (type-only over useChain).
export { useChainDepositAddress } from "./useChainDepositAddress";
export type { ChainDepositAddress } from "./useChainDepositAddress";

// ── Pure config (no heavy imports) ───────────────────────────────────────────
export {
  chainConfig,
  resolveChainConfig,
  LAMPORTS_PER_SOL,
  PLACEHOLDER_PROGRAM_ID,
  SEEDS,
} from "./config";
export type { ChainConfig, Cluster } from "./config";

// ── Pure bps parimutuel math (no heavy imports; safe to unit test) ───────────
export {
  BPS_DENOMINATOR,
  gross,
  net,
  poolAfterBet,
  indicativePayout,
  indicativeMultipleBps,
  bpsToMultiple,
  multipleToBps,
} from "./bps";

// ── Type-only surface (erased at compile time — zero runtime cost) ───────────
export type {
  OnChainSide,
  OnChainOutcome,
  OnChainMarketStatus,
  MarketAccount,
  BetAccount,
  MarketPdas,
  TxResult,
  WalletInfo,
  BetQuote,
  PlaceBetArgs,
  ClaimArgs,
} from "./types";
