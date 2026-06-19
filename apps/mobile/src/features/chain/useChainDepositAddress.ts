/**
 * useChainDepositAddress() — the deposit-address hook the WALLET feature consumes.
 *
 * This is the chain-side half of the contract documented in
 * `features/wallet/address.ts`: "when on-chain mode ships, `@/features/chain` is
 * expected to export a hook returning at least `{ ready, address? }` (the user's
 * embedded/connected Solana wallet pubkey)."
 *
 * It is a thin, type-only projection over `useChain()`, so a wallet screen can
 * import it WITHOUT pulling the Solana stack at module load — `useChain()` only
 * loads the heavy libs when `connect()` is called, and this hook never calls it.
 *
 * NOTE: the wallet feature's primary path reads the address through the global
 * STORE (`useDepositAddress` → `wallet.address` when `walletKind === 'embedded'`),
 * which `ChainProvider.connect()` populates. This hook is the DIRECT alternative
 * for any chain-aware UI (e.g. a "your on-chain wallet" panel) that wants the
 * live pubkey + balance + connect affordance without going through the store.
 */

import { useMemo } from "react";
import { useChain } from "./useChain";

export interface ChainDepositAddress {
  /** True when the embedded wallet is live and the address is real. */
  ready: boolean;
  /** The embedded wallet pubkey (base58), or undefined until connected. */
  address?: string;
  /** Live SOL balance of that address (0 until connected / read). */
  balanceSol: number;
  /** Which cluster the address lives on (for labelling: "devnet"). */
  cluster: ReturnType<typeof useChain>["cluster"];
  /** Cluster-aware explorer URL for the address (undefined until ready). */
  explorerUrl?: string;
  /** Turn on on-chain mode (lazy-loads the stack, then connects). */
  connect: () => Promise<boolean>;
}

export function useChainDepositAddress(): ChainDepositAddress {
  const chain = useChain();
  return useMemo<ChainDepositAddress>(
    () => ({
      ready: chain.ready,
      address: chain.address,
      balanceSol: chain.balanceSol,
      cluster: chain.cluster,
      explorerUrl: chain.address
        ? chain.explorerAddressUrl(chain.address)
        : undefined,
      connect: chain.connect,
    }),
    [
      chain.ready,
      chain.address,
      chain.balanceSol,
      chain.cluster,
      chain.connect,
      chain.explorerAddressUrl,
    ],
  );
}
