import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
} from "@privy-io/react-auth/solana";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import type { PrivySignerState } from "./provider";
import { chainConfig } from "./config";
import { privyChainForCluster } from "@/features/auth/privySolanaConfig";
import { sponsoredSendErrorMessage } from "./privyError";

/** Privy embedded wallet — never the external sign-in wallet. */
function embeddedWallet(
  wallets: ConnectedStandardSolanaWallet[] | undefined,
): ConnectedStandardSolanaWallet | undefined {
  return wallets?.find(
    (w) => w.standardWallet?.features && "privy:" in w.standardWallet.features,
  );
}

/**
 * WEB: the user's Privy embedded Solana wallet IS the chain wallet.
 *
 * Returns:
 *   • `privy`   — signed in + wallet ready → a serialize-in/serialize-out signer
 *                 wrapping Privy's wallet-standard `signTransaction` (no popup).
 *   • `pending` — Privy still booting OR not signed in → real mode must gate on
 *                 login; the chain layer stays disconnected (never falls back to
 *                 the fragile local keypair on web).
 */
export function usePrivyChainSigner(): PrivySignerState {
  const { authenticated, ready: privyReady } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = embeddedWallet(wallets);
  const address = wallet?.address;
  const privyChain = privyChainForCluster(chainConfig.cluster);

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
        sendSponsored: async (txBytes) => {
          try {
            const { signature } = await signAndSendTransaction({
              transaction: txBytes,
              wallet,
              chain: privyChain,
              options: { sponsor: true },
            });
            return signature;
          } catch (e) {
            console.error("[privy] signAndSendTransaction(sponsor:true) failed:", e);
            throw new Error(sponsoredSendErrorMessage(e));
          }
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
    privyChain,
  ]);
}
