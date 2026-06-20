import { useCallback, useEffect, useState } from "react";
import { defaultLiveUrl } from "@/lib/config";

export interface FeedHealth {
  ok: boolean;
  clients: number;
  feed: string;
  watcher: string;
  playPhase: string;
  lastPollAgeMs: number | null;
  marketsOpen: number;
}

export interface FeedMetrics {
  pollCount: number;
  marketsOpened: number;
  marketsSkipped: number;
  marketsVoided: number;
  aiBatchCalls: number;
  avgFeedLagMin: number;
  uptimeMs: number;
}

function feedBaseUrl(): string {
  const ws = defaultLiveUrl();
  return ws.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://")).replace(/\/ws\/?$/, "");
}

export function useFeedOps(enabled: boolean, intervalMs = 8000) {
  const [health, setHealth] = useState<FeedHealth | null>(null);
  const [metrics, setMetrics] = useState<FeedMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const base = feedBaseUrl();
    try {
      const [hRes, mRes] = await Promise.all([
        fetch(`${base}/health`),
        fetch(`${base}/metrics`),
      ]);
      if (!hRes.ok) throw new Error(`health ${hRes.status}`);
      setHealth((await hRes.json()) as FeedHealth);
      if (mRes.ok) setMetrics((await mRes.json()) as FeedMetrics);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unreachable");
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, refresh]);

  return { health, metrics, error, refresh };
}
