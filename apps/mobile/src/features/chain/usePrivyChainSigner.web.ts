import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import type { PrivySignerState } from "./provider";

/**
 * WEB: the user's Privy embedded Solana wallet IS the chain wallet.
 *
 * Returns:
 *   • `privy`   — signed in + wallet ready → a serialize-in/serialize-out signer
 *                 wrapping Privy's wallet-standard `signTransaction` (no popup).
 *   • `pending` — Privy still booting OR not signed in → real mode must gate on
 *                 login; the chain layer stays disconnected (never falls back to
 *                 the fragile local keypair on web).
 *
 * Imports none of GOLAZO's heavy chain libs (`@solana/web3.js` / anchor) — it
 * only forwards `Uint8Array`s, so OUR chain code stays behind the lazy `import()`
 * in `connect()`. (Privy's own deps — @solana/kit, viem — are already in the web
 * bundle via PrivyProvider regardless.)
 */
export function usePrivyChainSigner(): PrivySignerState {
  const { authenticated, ready: privyReady } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets?.[0];
  const address = wallet?.address;

  return useMemo<PrivySignerState>(() => {
    if (!privyReady || !authenticated || !walletsReady || !wallet || !address) {
      return { mode: "pending" };
    }
    return {
      mode: "privy",
      signer: {
        address,
        signSerialized: async (txBytes) => {
          const { signedTransaction } = await signTransaction({
            transaction: txBytes,
            wallet,
          });
          return signedTransaction;
        },
      },
    };
  }, [privyReady, authenticated, walletsReady, wallet, address, signTransaction]);
}
