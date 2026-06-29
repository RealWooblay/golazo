import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { privyAppId } from "./config";

const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: false });

/**
 * WEB Privy provider — email/passkey/wallet sign-in. Privy mints an embedded
 * Solana wallet for every user (bets, USX, gasless txs). External wallet is
 * sign-in only. If no app id, passthrough for the legacy keypair wallet.
 */
export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  const appId = privyAppId();
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "passkey", "wallet"],
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
      }}
    >
      {children}
    </PrivyProvider>
  );
}
