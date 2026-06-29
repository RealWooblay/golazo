import { useEffect } from "react";
import { feedHttpBase } from "@/lib/config";
import { usePointsIdentity } from "@/features/points/usePointsIdentity";
import { useStore } from "@/state/store";

const REF_STORAGE_KEY = "golazo:referral_code";
const POSTED_PREFIX = "golazo:referral_posted:";

function normalizeCode(raw: string | null): string {
  return (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function codeFromUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    return normalizeCode(
      url.searchParams.get("ref") ||
        url.searchParams.get("r") ||
        url.searchParams.get("code"),
    );
  } catch {
    return "";
  }
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Captures ?ref=CODE from partner links and attributes the current account/wallet
 * to that code once. No UI, no payout logic: the feed stores the durable ledger.
 */
export function useReferralAttribution() {
  const { liveUrl } = useStore();
  const { pointsUserId, walletReady } = usePointsIdentity();

  useEffect(() => {
    const storage = safeLocalStorage();
    if (!storage) return;
    const code = codeFromUrl();
    if (code) storage.setItem(REF_STORAGE_KEY, code);
  }, []);

  useEffect(() => {
    const storage = safeLocalStorage();
    if (!storage || !pointsUserId || !walletReady) return;
    const code = normalizeCode(storage.getItem(REF_STORAGE_KEY));
    if (!code) return;

    const postedKey = `${POSTED_PREFIX}${pointsUserId}:${code}`;
    if (storage.getItem(postedKey)) return;

    const source =
      typeof window !== "undefined" && window.location?.href
        ? window.location.href
        : undefined;

    void fetch(`${feedHttpBase(liveUrl)}/referrals/attribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: pointsUserId, code, source }),
    })
      .then((res) => {
        if (res.ok) storage.setItem(postedKey, "1");
      })
      .catch(() => {});
  }, [liveUrl, pointsUserId, walletReady]);
}
