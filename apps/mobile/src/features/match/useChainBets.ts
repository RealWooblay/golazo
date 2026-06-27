/**
 * On-chain betting for the live match — wallet + place_bet + claim against the on-chain market
 * twins, supporting multiple open markets at once, with live (pool-derived) odds + twin readiness.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketVM } from "@/state/types";
import { baseUnitsFromUsd, usdFromBaseUnits } from "@/features/chain/config";
import { holdBeforeChainBet } from "@/features/chain/betHold";
import type { UseChain } from "@/features/chain/useChain";
import type { OnChainSide } from "@/features/chain/types";
import type { ChainBetVM, ChainOdds } from "@/features/match/chainBetTypes";

const FEE_HEADROOM_SOL = 0.01;
const CHAIN_TWIN_POLL_MS = 1500;
const CHAIN_TWIN_MAX_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/0x177[c-d]|InsufficientVaultFunds|601[23]/i.test(raw)) {
    return "Vault short on devnet — retry claim in a few seconds.";
  }
  if (/0x1770|MarketNotOpen|\b6000\b/i.test(raw)) {
    return "That market just closed — the next one's seconds away.";
  }
  return raw || "On-chain action failed";
};

export interface UseChainBets {
  bets: ChainBetVM[];
  placing: boolean;
  error: string | null;
  isTwinReady: (marketId: string) => boolean;
  getLiveOdds: (marketId: string) => ChainOdds | null;
  getBet: (marketId: string) => ChainBetVM | undefined;
  placeBet: (
    market: MarketVM,
    side: "YES" | "NO",
    stakeUnits: number,
  ) => Promise<boolean>;
  claim: (marketId: string) => Promise<void>;
  markResolved: (outcomes: Map<string, "YES" | "NO" | "VOID">) => void;
  clearError: () => void;
}

export function useChainBets(
  chain: UseChain,
  stake: number,
  enabled: boolean,
  openMarkets: MarketVM[],
): UseChainBets {
  const [bets, setBets] = useState<ChainBetVM[]>([]);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveOdds, setLiveOdds] = useState<Record<string, ChainOdds>>({});
  const [twinReady, setTwinReady] = useState<Record<string, boolean>>({});
  const betsRef = useRef(bets);
  betsRef.current = bets;
  const openMarketsRef = useRef(openMarkets);
  openMarketsRef.current = openMarkets;

  const setBetFor = useCallback(
    (marketId: string, patch: Partial<ChainBetVM> | null) => {
      setBets((prev) => {
        if (!patch) return prev.filter((b) => b.offChainMarketId !== marketId);
        const idx = prev.findIndex((b) => b.offChainMarketId === marketId);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], ...patch };
        return next;
      });
    },
    [],
  );

  // Poll on-chain twins for every open market with onChain ref.
  useEffect(() => {
    if (!enabled || !chain.ready) return;
    let cancelled = false;
    const poll = async () => {
      const ready: Record<string, boolean> = {};
      const odds: Record<string, ChainOdds> = {};
      for (const m of openMarkets) {
        if (!m.onChain || m.phase !== "open") continue;
        const { authority, marketSeed } = m.onChain;
        const hasBet = betsRef.current.some(
          (b) => b.offChainMarketId === m.id,
        );
        try {
          const om = await chain.fetchMarket(authority, marketSeed);
          if (cancelled || !om) continue;
          ready[m.id] = true;
          if (!hasBet) {
            const py = Number(om.poolYesLamports);
            const pn = Number(om.poolNoLamports);
            const gross = py + pn;
            const stakeBaseUnits = baseUnitsFromUsd(stake);
            odds[m.id] = {
              oddsYes: chain.quoteBet(om, "Yes", stakeBaseUnits)
                .estimatedMultiple,
              oddsNo: chain.quoteBet(om, "No", stakeBaseUnits)
                .estimatedMultiple,
              yesShare: gross > 0 ? (100 * py) / gross : 50,
              poolUsd: usdFromBaseUnits(gross),
            };
          }
        } catch {
          /* rpc blip */
        }
      }
      if (!cancelled) {
        setTwinReady((prev) => ({ ...prev, ...ready }));
        setLiveOdds((prev) => ({ ...prev, ...odds }));
      }
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, chain, openMarkets, stake]);

  // A market disappearing off-chain is not enough to claim: the Solana mirror may
  // still be locking/resolving. Poll the actual program account and only enable
  // the button once it is settled there too.
  useEffect(() => {
    if (!enabled || !chain.ready) return;
    let cancelled = false;
    const poll = async () => {
      const updates: Record<string, Partial<ChainBetVM>> = {};
      for (const b of betsRef.current) {
        if (b.claimable || b.claimSignature || !b.resolvedOutcome) continue;
        try {
          const om = await chain.fetchMarket(b.authority, b.marketSeed);
          if (!om || (om.status !== "Resolved" && om.status !== "Void")) continue;
          const outcome =
            om.status === "Void"
              ? "VOID"
              : om.outcome === "Yes"
                ? "YES"
                : om.outcome === "No"
                  ? "NO"
                  : b.resolvedOutcome;
          updates[b.offChainMarketId] = {
            claimable: true,
            resolvedOutcome: outcome,
            won: outcome !== "VOID" && b.side === outcome,
          };
        } catch {
          /* rpc blip */
        }
      }
      if (cancelled || Object.keys(updates).length === 0) return;
      setBets((prev) =>
        prev.map((b) =>
          updates[b.offChainMarketId]
            ? { ...b, ...updates[b.offChainMarketId] }
            : b,
        ),
      );
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, chain]);

  const waitForTwin = useCallback(
    async (authority: string, marketSeed: number): Promise<boolean> => {
      const deadline = Date.now() + CHAIN_TWIN_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const m = await chain.fetchMarket(authority, marketSeed);
        if (m) return true;
        await sleep(CHAIN_TWIN_POLL_MS);
      }
      return false;
    },
    [chain],
  );

  const placeBet = useCallback(
    async (
      market: MarketVM,
      side: "YES" | "NO",
      stakeUnits: number,
    ): Promise<boolean> => {
      const onChain = market.onChain;
      if (!enabled || !onChain || !chain.ready || placing) return false;
      const { authority, marketSeed } = onChain;
      const stakeBaseUnits = baseUnitsFromUsd(stakeUnits);

      if (chain.balanceUsd < stakeUnits) {
        setError("Low USX balance — fund your wallet in the Wallet tab.");
        return false;
      }
      if (chain.balanceSol < FEE_HEADROOM_SOL) {
        setError("Low SOL for fees — add a little SOL in the Wallet tab.");
        return false;
      }
      if (betsRef.current.some((b) => b.offChainMarketId === market.id)) {
        setError("One on-chain bet per market.");
        return false;
      }

      setPlacing(true);
      setError(null);
      try {
        if (!twinReady[market.id]) {
          const ok = await waitForTwin(authority, marketSeed);
          if (!ok) {
            setError("On-chain market not ready — wait a moment and tap again.");
            return false;
          }
          setTwinReady((prev) => ({ ...prev, [market.id]: true }));
        }

        const hold = await holdBeforeChainBet(() => {
          const live = openMarketsRef.current.find((m) => m.id === market.id);
          return !!live && live.phase === "open";
        });
        if (!hold.ok) {
          setError(hold.reason ?? "Bet not accepted");
          return false;
        }

        const om = await chain.fetchMarket(authority, marketSeed);
        if (!om) {
          setError("On-chain market not found — tap bet again in a moment.");
          return false;
        }
        // Just-in-time guard: if the on-chain twin already locked (we lost the latency
        // race despite the operator's lock grace), don't submit a place_bet that will
        // revert MarketNotOpen — surface a clean message instead of a raw 0x1770.
        if (om.status !== "Open") {
          setError("That market just closed — the next one's seconds away.");
          return false;
        }

        const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
        const quote = chain.quoteBet(om, onChainSide, stakeBaseUnits);
        const res = await chain.placeBetOnChain({
          authority,
          marketSeed,
          side: onChainSide,
          stakeLamports: stakeBaseUnits,
        });

        setBets((prev) => [
          ...prev,
          {
            marketSeed,
            authority,
            offChainMarketId: market.id,
            question: market.question,
            side,
            stakeUsd: stakeUnits,
            estimatedMultiple: quote.estimatedMultiple,
            betSignature: res.signature,
            betUrl: res.explorerUrl,
            claimable: false,
            claiming: false,
          },
        ]);
        return true;
      } catch (e) {
        setError(errMsg(e));
        return false;
      } finally {
        setPlacing(false);
      }
    },
    [enabled, chain, placing, twinReady, waitForTwin],
  );

  const claim = useCallback(
    async (marketId: string) => {
      const bet = betsRef.current.find((b) => b.offChainMarketId === marketId);
      if (!bet || !chain.ready || bet.claiming || bet.claimSignature) return;
      setBetFor(marketId, { claiming: true });
      setError(null);
      try {
        const market = await chain.fetchMarket(bet.authority, bet.marketSeed);
        if (!market || (market.status !== "Resolved" && market.status !== "Void")) {
          setError("Settlement still finalizing on devnet — claim unlocks in a moment.");
          setBetFor(marketId, { claiming: false });
          return;
        }
        let res = null as Awaited<ReturnType<UseChain["claim"]>> | null;
        let lastErr: unknown = null;
        for (let i = 0; i < 6 && !res; i++) {
          try {
            res = await chain.claim({
              authority: bet.authority,
              marketSeed: bet.marketSeed,
            });
          } catch (e) {
            lastErr = e;
            await sleep(2500);
          }
        }
        if (!res) throw lastErr ?? new Error("Claim failed");
        setBetFor(marketId, {
          claiming: false,
          claimSignature: res.signature,
          claimUrl: res.explorerUrl,
        });
      } catch (e) {
        setError(errMsg(e));
        setBetFor(marketId, { claiming: false });
      }
    },
    [chain, setBetFor],
  );

  const markResolved = useCallback((outcomes: Map<string, "YES" | "NO" | "VOID">) => {
    setBets((prev) =>
      prev.map((b) => {
        const outcome = outcomes.get(b.offChainMarketId);
        return outcome && !b.resolvedOutcome
          ? {
              ...b,
              resolvedOutcome: outcome,
              won: outcome !== "VOID" && b.side === outcome,
            }
          : b;
      }),
    );
  }, []);

  const getBet = useCallback(
    (marketId: string) =>
      bets.find((b) => b.offChainMarketId === marketId),
    [bets],
  );

  return {
    bets,
    placing,
    error,
    isTwinReady: (id) => !!twinReady[id],
    getLiveOdds: (id) => liveOdds[id] ?? null,
    getBet,
    placeBet,
    claim,
    markResolved,
    clearError: () => setError(null),
  };
}
