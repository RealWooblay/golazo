import Constants from "expo-constants";

/**
 * Privy app id (PUBLIC — it ships in the client, like a Firebase config). Read
 * from EXPO_PUBLIC_PRIVY_APP_ID first, then app.json `extra.PRIVY_APP_ID`. Empty
 * → Privy is OFF and the app falls back to the legacy embedded keypair wallet, so
 * nothing breaks when it's not configured.
 */
export function privyAppId(): string | undefined {
  const fromEnv =
    typeof process !== "undefined"
      ? (process.env?.EXPO_PUBLIC_PRIVY_APP_ID as string | undefined)
      : undefined;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const v = extra.PRIVY_APP_ID;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** True when Privy is configured (an app id is present). */
export function privyEnabled(): boolean {
  return !!privyAppId();
}
