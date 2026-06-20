/**
 * Default / NATIVE account hook — a disabled stub.
 *
 * The real implementation is `useAccount.web.ts` (Privy is a web SDK here).
 * Native would use `@privy-io/expo` later; until then `enabled: false` makes the
 * UI fall back to the legacy embedded wallet. `tsc` resolves THIS file for the
 * `@/features/auth/useAccount` import, so its shape must match the web version.
 */
export function useAccount() {
  return {
    enabled: false,
    ready: true,
    authenticated: false,
    handle: null as string | null,
    solanaAddress: null as string | null,
    login: () => {},
    logout: async () => {},
  };
}

export type AccountState = ReturnType<typeof useAccount>;
