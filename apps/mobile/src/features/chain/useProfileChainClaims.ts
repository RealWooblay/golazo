/**
 * Scan persisted open on-chain bets and claim them one-by-one (profile safety net).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/state/store";
import type { OpenChainBetRecord } from "@/state/types";
import type { UseChain } from "@/features/chain/useChain";

const SCAN_MS = 2500;

export function useProfileChainClaims(chain: UseChain, enabled: boolean) {
  const store = useStore();
  const [claimable, setClaimable] = useState<OpenChainBetRecord[]>([]);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drainRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!enabled || !chain.ready) {
      setClaimable([]);
      return;
    }
    let cancelled = false;

    const scan = async () => {
      const ready: OpenChainBetRecord[] = [];
      for (const rec of store.openChainBets) {
        try {
          const [om, bet] = await Promise.all([
            chain.fetchMarket(rec.authority, rec.marketSeed),
            chain.fetchBet(rec.authority, rec.marketSeed),
          ]);
          if (!bet) continue;
          if (bet.claimed) {
            store.removeOpenChainBet(rec.marketId);
            continue;
          }
          if (
            om &&
            (om.status === "Resolved" || om.status === "Void")
          ) {
            ready.push(rec);
          }
        } catch {
          /* rpc blip */
        }
      }
      if (!cancelled) setClaimable(ready);
    };

    void scan();
    const id = setInterval(() => void scan(), SCAN_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, chain, store.openChainBets, store.removeOpenChainBet]);

  const claimAll = useCallback(async () => {
    if (!chain.ready || claiming || claimable.length === 0) return;
    if (drainRef.current) {
      await drainRef.current;
      return;
    }
    setClaiming(true);
    setError(null);
    drainRef.current = (async () => {
      try {
        for (const rec of claimable) {
          const om = await chain.fetchMarket(rec.authority, rec.marketSeed);
          const bet = await chain.fetchBet(rec.authority, rec.marketSeed);
          if (!bet || bet.claimed) {
            store.removeOpenChainBet(rec.marketId);
            continue;
          }
          if (!om || (om.status !== "Resolved" && om.status !== "Void")) continue;
          await chain.claim({
            authority: rec.authority,
            marketSeed: rec.marketSeed,
          });
          store.removeOpenChainBet(rec.marketId);
        }
        await chain.refreshBalance();
        setClaimable([]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Claim failed");
      } finally {
        setClaiming(false);
        drainRef.current = null;
      }
    })();
    await drainRef.current;
  }, [chain, claiming, claimable, store]);

  return {
    claimableCount: claimable.length,
    claiming,
    error,
    claimAll,
    clearError: () => setError(null),
  };
}
