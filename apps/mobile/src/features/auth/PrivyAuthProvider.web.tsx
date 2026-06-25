import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { privyAppId } from "./config";

/**
 * WEB Privy provider — wraps the app in the real Privy so email/Google/Apple/
 * passkey login mints a recoverable, self-custodial Solana embedded wallet (no
 * seed phrase). If no app id is configured, this is a passthrough so the legacy
 * embedded-keypair wallet keeps working.
 */
export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  const appId = privyAppId();
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "passkey"],
        appearance: { theme: "dark", accentColor: "#00e58a" },
        // Auto-create a Solana embedded wallet for users who log in without one,
        // and sign WITHOUT a confirmation modal — bets must be one-tap, with zero
        // web3 surface. (showWalletUIs:false suppresses Privy's sign/send UIs;
        // the embedded key is Privy-managed so no per-tx approval is needed.)
        embeddedWallets: {
          showWalletUIs: false,
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
