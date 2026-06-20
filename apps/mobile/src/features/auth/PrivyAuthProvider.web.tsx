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
        loginMethods: ["email", "google", "apple", "passkey"],
        appearance: { theme: "dark", accentColor: "#00e58a" },
        // Auto-create a Solana embedded wallet for users who log in without one.
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
