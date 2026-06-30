import React, { useMemo } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { privyAppId } from "./config";
import { buildPrivySolanaRpcs } from "./privySolanaConfig";

const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: false });

/**
 * WEB Privy provider — email/wallet sign-in. Privy mints an embedded
 * Solana wallet for every user (bets, USX, gasless txs). External wallet is
 * sign-in only. If no app id, passthrough for the legacy keypair wallet.
 */
export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  const appId = privyAppId();
  const solanaRpcs = useMemo(() => buildPrivySolanaRpcs(), []);
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#00e58a",
          walletChainType: "solana-only",
          walletList: ["phantom", "solflare", "detected_solana_wallets"],
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
        embeddedWallets: {
          showWalletUIs: false,
          solana: { createOnLogin: "all-users" },
        },
        // Required for embedded-wallet signAndSendTransaction + gas sponsorship on Solana.
        solana: { rpcs: solanaRpcs },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
