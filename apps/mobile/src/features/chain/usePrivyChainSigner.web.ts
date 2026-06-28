import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
} from "@privy-io/react-auth/solana";
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
  const { signAndSendTransaction } = useSignAndSendTransaction();
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
        // GASLESS: sign + send with Privy paying the Solana fee (native gas
        // sponsorship, sponsor:true) so a bettor never needs SOL. Returns the raw
        // signature bytes; provider.ts base58-encodes it. Requires gas sponsorship
        // enabled in the Privy dashboard; if it's off, Privy errors and the caller
        // surfaces it (we don't silently charge the user).
        sendSponsored: async (txBytes) => {
          const { signature } = await signAndSendTransaction({
            transaction: txBytes,
            wallet,
            options: { sponsor: true },
          });
          return signature;
        },
      },
    };
  }, [
    privyReady,
    authenticated,
    walletsReady,
    wallet,
    address,
    signTransaction,
    signAndSendTransaction,
  ]);
}
