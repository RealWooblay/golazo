import Constants from "expo-constants";
import { WS_DEFAULT_PORT } from "@golazo/core";

/**
 * App-wide tunables. The economic constants deliberately mirror @golazo/core's
 * pure parimutuel defaults: no house-seeded liquidity, fixed rake only.
 *
 * The default live URL is derived at runtime from the Metro host so that on a
 * physical device "localhost" resolves to your dev machine, not the phone. You
 * can always override it on the Settings screen.
 */

export const RAKE = 0.06; // 6% house rake — matches MarketEngine default + prototype
export const BASE_SEED = 0; // zero-capital parimutuel: liquidity comes from bettors

export const START_BALANCE = 1000; // play-money starting balance
export const STAKE_CHIPS = [10, 25, 50, 100] as const; // tappable stake presets
export const DEFAULT_STAKE = 25;

export const USER_ID = "me"; // single local user; the engine keys bets by userId

/**
 * Build the LIVE WebSocket URL.
 *
 * Priority:
 *   1. An explicit FEED URL (EXPO_PUBLIC_FEED_URL / app.json extra.FEED_URL) —
 *      REQUIRED for a hosted web/native deploy, where there's no Metro host to
 *      derive from. Use `wss://…` when the app is served over https.
 *   2. Dev fallback: derive the host from the Metro bundler (so a phone on the
 *      LAN reaches your dev machine, not "localhost") + the feed's default port.
 */
export function defaultLiveUrl(): string {
  const configured = readFeedUrl();
  if (configured) return configured;
  // expo-constants exposes the Metro bundler host (e.g. "192.168.1.5:8081").
  // We reuse just the hostname and swap in the feed service's port.
  const hostUri =
    Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri ? hostUri.split(":")[0] : "localhost";
  return `ws://${host}:${WS_DEFAULT_PORT}`;
}

/** Explicit feed URL from env / app.json extra (empty → use the dev fallback). */
function readFeedUrl(): string | undefined {
  const fromProcess =
    typeof process !== "undefined"
      ? (process.env?.EXPO_PUBLIC_FEED_URL as string | undefined)
      : undefined;
  if (fromProcess && fromProcess.length > 0) return fromProcess.trim();
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const v = extra.FEED_URL;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
