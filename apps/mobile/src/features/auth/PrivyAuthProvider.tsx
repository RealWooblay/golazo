import React from "react";

/**
 * Default / NATIVE Privy provider — a PASSTHROUGH.
 *
 * Web uses the real Privy via the `.web.tsx` override (Metro picks it up on web).
 * Native would use `@privy-io/expo` (a separate, future integration), so the base
 * file is a no-op: the native bundle never imports the web-only SDK, and `tsc`
 * resolves this file for the `@/features/auth/PrivyAuthProvider` import.
 */
export function PrivyAuthProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
