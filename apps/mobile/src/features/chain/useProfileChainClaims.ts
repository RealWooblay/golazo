/**
 * MONEY RECOVERY (profile safety net): scan the wallet's on-chain Bet PDAs for EVERY settled,
 * unclaimed bet — refunds from voided markets + wins — and claim them. Discovery is on-chain
 * (getProgramAccounts by bettor), NOT local state, so a bet placed on another device or after a
 * storage clear is still found. Claim is bettor-only, so this is the only way the USX comes back.
 */
import { useCallback, useEffect, useState } from "react";
import type { UseChain } from "@/features/chain/useChain";
import type { ClaimableBet } from "@/features/chain/client";

export function useProfileChainClaims(chain: UseChain, enabled: boolean) {
  const [claimable, setClaimable] = useState<ClaimableBet[]>([]);
  const [scanning, setScanning] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scan the chain for unclaimed settled bets. getProgramAccounts is heavy, so we run it once on
  // open + after a claim + on manual refresh — NOT on a tight interval.
  const refresh = useCallback(async () => {
    if (!enabled || !chain.ready) {
      setClaimable([]);
      return;
    }
    setScanning(true);
    try {
      setClaimable(await chain.scanUnclaimed());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't scan for unclaimed bets");
    } finally {
      setScanning(false);
    }
  }, [enabled, chain]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claimAll = useCallback(async () => {
    if (!chain.ready || claiming || claimable.length === 0) return;
    setClaiming(true);
    setError(null);
    try {
      for (const rec of claimable) {
        // Claim each settled bet (VOID refund or win) — closes the Bet PDA + returns the USX.
        await chain.claim({ authority: rec.authority, marketSeed: rec.marketSeed });
      }
      await chain.refreshBalance();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setClaiming(false);
      void refresh(); // re-scan to confirm what actually cleared
    }
  }, [chain, claiming, claimable, refresh]);

  // USX is 6dp; estPayoutLamports is base units. Sum = the "$X waiting for you" prompt.
  const claimableUsd = claimable.reduce((s, b) => s + Number(b.estPayoutLamports) / 1e6, 0);

  return {
    claimable,
    claimableCount: claimable.length,
    claimableUsd,
    scanning,
    claiming,
    error,
    claimAll,
    refresh,
    clearError: () => setError(null),
  };
}
