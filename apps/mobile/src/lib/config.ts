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

/** Mirror server: stop accepting bets this many ms before lockAt (base cap). */
export const BET_SAFETY_BUFFER_MS = 2000;

/** Anti-latency hold before on-chain bets land (matches server BET_DELAY_MS). */
export const BET_DELAY_MS = Number(
  (typeof process !== "undefined" && process.env?.EXPO_PUBLIC_BET_DELAY_MS) ||
    5000,
);

export function bettingSafetyBufferMs(windowMs: number): number {
  return Math.min(BET_SAFETY_BUFFER_MS, Math.max(800, Math.floor(windowMs * 0.2)));
}

/** Wall-clock after which the UI disables bet buttons (engine may still be "open"). */
export function bettingClosesAt(lockAt: number, windowMs = 10_000): number {
  return lockAt - bettingSafetyBufferMs(windowMs);
}

/**
 * Build the LIVE WebSocket URL.
 *
 * Priority:
 *   1. An explicit FEED URL (EXPO_PUBLIC_FEED_URL / app.json extra.FEED_URL).
 *      Use `wss://…` when the app is served over https.
 *   2. Hosted web: same origin + `/ws` (the static server proxies to the feed).
 *   3. Dev fallback: derive the host from the Metro bundler (so a phone on the
 *      LAN reaches your dev machine, not "localhost") + the feed's default port.
 */
export function defaultLiveUrl(): string {
  const configured = readFeedUrl();
  if (configured && !isPlaceholderFeedUrl(configured)) return configured;

  // Static web deploy — derive from the page origin. The AWS static server proxies
  // `/ws` → localhost:8787 so we never need a separate port in the client URL.
  if (typeof window !== "undefined" && window.location?.hostname) {
    const { protocol, hostname, port } = window.location;
    const wsProto = protocol === "https:" ? "wss:" : "ws:";
    const host =
      port && port !== "80" && port !== "443"
        ? `${hostname}:${port}`
        : hostname;
    return `${wsProto}//${host}/ws`;
  }

  // expo-constants exposes the Metro bundler host (e.g. "192.168.1.5:8081").
  // We reuse just the hostname and swap in the feed service's port.
  const hostUri =
    Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri ? hostUri.split(":")[0] : "localhost";
  return `ws://${host}:${WS_DEFAULT_PORT}`;
}

function isPlaceholderFeedUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.includes("your-feed-host") || u.includes("localhost:8080");
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
