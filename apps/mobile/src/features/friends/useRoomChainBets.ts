/**
 * On-chain betting for FRIENDS rooms — same wallet + place_bet + claim flow as the
 * public match, but supports multiple open room markets at once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketVM } from "@/state/types";
import { LAMPORTS_PER_SOL } from "@/features/chain/config";
import { holdBeforeChainBet } from "@/features/chain/betHold";
import type { UseChain } from "@/features/chain/useChain";
import type { OnChainSide } from "@/features/chain/types";
import type { ChainBetVM, ChainOdds } from "@/features/match/useChainBet";

const SOL_PER_UNIT = 0.01;
const FEE_HEADROOM_SOL = 0.01;
const CHAIN_TWIN_POLL_MS = 1500;
const CHAIN_TWIN_MAX_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/0x177[c-d]|InsufficientVaultFunds|601[23]/i.test(raw)) {
    return "Vault short on devnet — retry claim in a few seconds.";
  }
  return raw || "On-chain action failed";
};

export interface UseRoomChainBets {
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
  markResolved: (marketIds: Set<string>) => void;
  clearError: () => void;
}

export function useRoomChainBets(
  chain: UseChain,
  stake: number,
  enabled: boolean,
  openMarkets: MarketVM[],
): UseRoomChainBets {
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
            const stakeLamports = Math.round(
              stake * SOL_PER_UNIT * LAMPORTS_PER_SOL,
            );
            odds[m.id] = {
              oddsYes: chain.quoteBet(om, "Yes", stakeLamports)
                .estimatedMultiple,
              oddsNo: chain.quoteBet(om, "No", stakeLamports)
                .estimatedMultiple,
              yesShare: gross > 0 ? (100 * py) / gross : 50,
              poolSol: gross / LAMPORTS_PER_SOL,
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
      const stakeSol = stakeUnits * SOL_PER_UNIT;
      const stakeLamports = Math.round(stakeSol * LAMPORTS_PER_SOL);

      if (chain.balanceSol < stakeSol + FEE_HEADROOM_SOL) {
        setError("Low balance — fund your wallet in the Wallet tab.");
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

        const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
        const quote = chain.quoteBet(om, onChainSide, stakeLamports);
        const res = await chain.placeBetOnChain({
          authority,
          marketSeed,
          side: onChainSide,
          stakeLamports,
        });

        setBets((prev) => [
          ...prev,
          {
            marketSeed,
            authority,
            offChainMarketId: market.id,
            question: market.question,
            side,
            stakeSol,
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

  const markResolved = useCallback((marketIds: Set<string>) => {
    setBets((prev) =>
      prev.map((b) =>
        marketIds.has(b.offChainMarketId) && !b.claimable
          ? { ...b, claimable: true }
          : b,
      ),
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
