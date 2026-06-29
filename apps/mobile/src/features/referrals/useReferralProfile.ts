import { useCallback, useEffect, useMemo, useState } from "react";
import { feedHttpBase } from "@/lib/config";
import { useStore } from "@/state/store";
import { usePointsIdentity } from "@/features/points/usePointsIdentity";

export interface ReferralAttribution {
  userId: string;
  code: string;
  ownerId: string;
  attributedAt: number;
  source?: string;
}

export interface ReferralCode {
  code: string;
  ownerId: string;
  ownerLabel?: string;
  payoutBps: number;
  active: boolean;
  createdAt: number;
}

export interface ReferralSummary {
  code?: string;
  ownerId?: string;
  attributedUsers: number;
  volume: number;
  grossFees: number;
  referrerEarned: number;
  referrerPaid: number;
  referrerUnpaid: number;
  platformNetFees: number;
  entries: number;
}

interface ReferralProfileResponse {
  userId: string;
  attribution?: ReferralAttribution;
  ownedCodes: ReferralCode[];
  summary: ReferralSummary;
}

const REF_STORAGE_KEY = "golazo:referral_code";

export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Error(body.error || body.reason || "Referral request failed");
  return body;
}

export function useReferralProfile() {
  const { liveUrl } = useStore();
  const { pointsUserId, walletReady } = usePointsIdentity();
  const base = useMemo(() => feedHttpBase(liveUrl), [liveUrl]);

  const [profile, setProfile] = useState<ReferralProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    if (!pointsUserId || !walletReady) return;
    const next = await readJson<ReferralProfileResponse>(
      `${base}/referrals/profile?userId=${encodeURIComponent(pointsUserId)}`,
    );
    setProfile(next);
  }, [base, pointsUserId, walletReady]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refreshProfile()
      .catch((err) => {
        if (!cancelled) setMessage((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshProfile]);

  const applyCode = useCallback(
    async (codeRaw: string) => {
      const code = normalizeReferralCode(codeRaw);
      if (!code) {
        setMessage("Enter a code");
        return false;
      }
      if (!pointsUserId || !walletReady) {
        setMessage("Sign in and wait for your wallet to load");
        return false;
      }
      setLoading(true);
      setMessage(null);
      try {
        const result = await readJson<{
          ok: boolean;
          created: boolean;
          attribution?: ReferralAttribution;
          reason?: string;
        }>(`${base}/referrals/attribute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: pointsUserId, code, source: "profile" }),
        });
        if (!result.ok) throw new Error(result.reason || "Code not accepted");
        safeLocalStorage()?.setItem(REF_STORAGE_KEY, code);
        await refreshProfile();
        setMessage(result.created ? `Linked to ${code}` : `Already linked to ${result.attribution?.code ?? code}`);
        return true;
      } catch (err) {
        setMessage((err as Error).message);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [base, pointsUserId, walletReady, refreshProfile],
  );

  const myCode = profile?.ownedCodes[0]?.code ?? null;
  const mySummary = profile?.summary ?? null;

  return {
    userId: pointsUserId,
    profile,
    attribution: profile?.attribution ?? null,
    myCode,
    mySummary,
    loading,
    message,
    applyCode,
    refresh: refreshProfile,
  };
}
