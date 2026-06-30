/**
 * On-chain betting for the live match — wallet + place_bet + claim against the on-chain market
 * twins, supporting multiple open markets at once, with live (pool-derived) odds + twin readiness.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketVM } from "@/state/types";
import { useStore } from "@/state/store";
import { baseUnitsFromUsd, usdFromBaseUnits } from "@/features/chain/config";
import { net as bpsNet, heldBetMultiple } from "@/features/chain/bps";
import { holdBeforeChainBet } from "@/features/chain/betHold";
import type { UseChain } from "@/features/chain/useChain";
import type { OnChainSide } from "@/features/chain/types";
import type { ChainBetVM, ChainOdds, ChainPoolCache } from "@/features/match/chainBetTypes";

const CHAIN_TWIN_POLL_MS = 1500;
/** Fast poll while a market is open — YES/NO multiples track the on-chain pool. */
const CHAIN_ODDS_POLL_OPEN_MS = 400;
/** Slower poll for locked bets waiting on resolution. */
const CHAIN_ODDS_POLL_LOCKED_MS = 1500;
/** Minimum real-money bet (USX). Floors out dust bets that cost more in sponsored gas +
 *  account rent than they stake — a small abuse/UX guard. The real sponsorship-abuse defense
 *  is the Privy dashboard policy (program allowlist + spend cap + per-wallet rate limit). */
const MIN_STAKE_USD = 1;
const CHAIN_TWIN_MAX_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function oddsFromPool(
  chain: UseChain,
  cache: ChainPoolCache,
  stakeUsd: number,
): ChainOdds {
  const om = {
    poolYesLamports: cache.poolYesLamports,
    poolNoLamports: cache.poolNoLamports,
    rakeBps: cache.rakeBps,
  };
  const stakeBase = baseUnitsFromUsd(stakeUsd);
  const py = Number(cache.poolYesLamports);
  const pn = Number(cache.poolNoLamports);
  const gross = py + pn;
  return {
    oddsYes: chain.quoteBet(om, "Yes", stakeBase).estimatedMultiple,
    oddsNo: chain.quoteBet(om, "No", stakeBase).estimatedMultiple,
    yesShare: gross > 0 ? (100 * py) / gross : 50,
    poolUsd: usdFromBaseUnits(gross),
  };
}

const errMsg = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/AccountNotInitialized|0xbc4|\b3012\b/i.test(raw)) {
    return "Bet still confirming on-chain — wait a moment, then try again.";
  }
  if (/0x177[c-d]|InsufficientVaultFunds|601[23]/i.test(raw)) {
    return "Vault still settling — retry claim in a few seconds.";
  }
  if (/0x1770|MarketNotOpen|\b6000\b/i.test(raw)) {
    return "That market just closed — the next one's seconds away.";
  }
  if (/gas sponsorship failed/i.test(raw)) return raw;
  return raw || "On-chain action failed";
};

export interface UseChainBets {
  bets: ChainBetVM[];
  /** Market id while a chain bet tx is in flight (other open cards stay tappable). */
  placingMarketId: string | null;
  error: string | null;
  isTwinReady: (marketId: string) => boolean;
  getLiveOdds: (marketId: string, stakeUsd?: number) => ChainOdds | null;
  /** Live multiple for an existing on-chain bet (stake already in the pool). */
  getHeldMultiple: (
    marketId: string,
    side: "YES" | "NO",
    stakeUsd: number,
  ) => number | null;
  getBet: (marketId: string) => ChainBetVM | undefined;
  placeBet: (
    market: MarketVM,
    side: "YES" | "NO",
    stakeUnits: number,
  ) => Promise<boolean>;
  claim: (marketId: string) => Promise<void>;
  /** Claim every resolved, unclaimed bet — one tx at a time. */
  claimAll: () => Promise<void>;
  markResolved: (outcomes: Map<string, "YES" | "NO" | "VOID">) => void;
  /** Hide the tap-to-reveal card after the user opens it (claim continues in background). */
  dismissReveal: (marketId: string) => void;
  isRevealDismissed: (marketId: string) => boolean;
  clearError: () => void;
}

export function useChainBets(
  chain: UseChain,
  stake: number,
  enabled: boolean,
  openMarkets: MarketVM[],
): UseChainBets {
  const [bets, setBets] = useState<ChainBetVM[]>([]);
  const [placingMarketId, setPlacingMarketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poolCache, setPoolCache] = useState<Record<string, ChainPoolCache>>({});
  const [twinReady, setTwinReady] = useState<Record<string, boolean>>({});
  const [dismissedReveals, setDismissedReveals] = useState<Set<string>>(() => new Set());
  const store = useStore();
  const betsRef = useRef(bets);
  betsRef.current = bets;
  const openMarketsRef = useRef(openMarkets);
  openMarketsRef.current = openMarkets;
  /** USX reserved by in-flight place_bet txs (balance refresh lags behind). */
  const reservedStakeRef = useRef(0);
  const claimQueueRef = useRef<string[]>([]);
  const claimDrainRef = useRef<Promise<void> | null>(null);

  const persistOpenBet = useCallback(
    (
      bet: Pick<
        ChainBetVM,
        | "offChainMarketId"
        | "authority"
        | "marketSeed"
        | "question"
        | "side"
        | "stakeUsd"
        | "placedAt"
      >,
    ) => {
      store.upsertOpenChainBet({
        marketId: bet.offChainMarketId,
        authority: bet.authority,
        marketSeed: bet.marketSeed,
        question: bet.question,
        side: bet.side,
        stakeUsd: bet.stakeUsd,
        placedAt: bet.placedAt,
      });
    },
    [store],
  );

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

  const applyMarketPool = useCallback(
    (
      marketId: string,
      om: NonNullable<Awaited<ReturnType<UseChain["fetchMarket"]>>>,
    ) => {
      setPoolCache((prev) => ({
        ...prev,
        [marketId]: {
          poolYesLamports: om.poolYesLamports,
          poolNoLamports: om.poolNoLamports,
          rakeBps: om.rakeBps,
        },
      }));
      setTwinReady((prev) => ({ ...prev, [marketId]: true }));
    },
    [],
  );

  // After reload / missed local state, pull the user's on-chain bet accounts into UI.
  useEffect(() => {
    if (!enabled || !chain.ready) return;
    let cancelled = false;

    const hydrate = async () => {
      const patches: ChainBetVM[] = [];
      for (const m of openMarketsRef.current) {
        if (!m.onChain) continue;
        if (betsRef.current.some((b) => b.offChainMarketId === m.id)) continue;
        const { authority, marketSeed } = m.onChain;
        try {
          const onChainBet = await chain.fetchBet(authority, marketSeed);
          if (cancelled || !onChainBet || onChainBet.claimed) continue;
          const om = await chain.fetchMarket(authority, marketSeed);
          if (!om || om.status === "Resolved" || om.status === "Void") continue;
          const side = onChainBet.side === "Yes" ? "YES" : "NO";
          const stakeUsd = usdFromBaseUnits(onChainBet.stakeLamports);
          const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
          const estimatedMultiple = heldBetMultiple(
            om.poolYesLamports,
            om.poolNoLamports,
            om.rakeBps,
            onChainSide,
            onChainBet.stakeLamports,
          );
          const placedAt =
            store.openChainBets.find((rec) => rec.marketId === m.id)?.placedAt ??
            Date.now();
          applyMarketPool(m.id, om);
          patches.push({
            marketSeed,
            authority,
            offChainMarketId: m.id,
            question: m.question,
            side,
            stakeUsd,
            placedAt,
            estimatedMultiple,
            betSignature: `hydrated-${onChainBet.address}`,
            betUrl: chain.explorerAddressUrl(onChainBet.address),
            claimable: false,
            claiming: false,
          });
          persistOpenBet({
            offChainMarketId: m.id,
            authority,
            marketSeed,
            question: m.question,
            side,
            stakeUsd,
            placedAt,
          });
        } catch {
          /* rpc blip */
        }
      }
      if (cancelled || patches.length === 0) return;
      setBets((prev) => {
        const known = new Set(prev.map((b) => b.offChainMarketId));
        const fresh = patches.filter((p) => !known.has(p.offChainMarketId));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    };

    void hydrate();
  }, [enabled, chain, openMarkets, applyMarketPool, persistOpenBet]);

  const refreshMarketPool = useCallback(
    async (marketId: string, authority: string, marketSeed: number) => {
      const om = await chain.fetchMarket(authority, marketSeed);
      if (om) applyMarketPool(marketId, om);
      return om;
    },
    [chain, applyMarketPool],
  );

  // Poll on-chain pool — cache raw pools; odds are derived instantly at render time.
  useEffect(() => {
    if (!enabled || !chain.ready) return;
    let cancelled = false;

    const pollOpen = async () => {
      const multPatches: Record<string, number> = {};
      const polled = new Set<string>();

      for (const m of openMarkets) {
        if (!m.onChain || m.phase !== "open") continue;
        polled.add(m.id);
        const { authority, marketSeed } = m.onChain;
        const existing = betsRef.current.find((b) => b.offChainMarketId === m.id);
        try {
          const om = await chain.fetchMarket(authority, marketSeed);
          if (cancelled || !om) continue;
          applyMarketPool(m.id, om);
          if (existing && !existing.resolvedOutcome) {
            const side: OnChainSide = existing.side === "YES" ? "Yes" : "No";
            multPatches[m.id] = heldBetMultiple(
              om.poolYesLamports,
              om.poolNoLamports,
              om.rakeBps,
              side,
              BigInt(baseUnitsFromUsd(existing.stakeUsd)),
            );
          }
        } catch {
          /* rpc blip */
        }
      }

      for (const b of betsRef.current) {
        if (b.resolvedOutcome || polled.has(b.offChainMarketId)) continue;
        try {
          const om = await chain.fetchMarket(b.authority, b.marketSeed);
          if (cancelled || !om || om.status === "Resolved" || om.status === "Void") continue;
          applyMarketPool(b.offChainMarketId, om);
          const side: OnChainSide = b.side === "YES" ? "Yes" : "No";
          multPatches[b.offChainMarketId] = heldBetMultiple(
            om.poolYesLamports,
            om.poolNoLamports,
            om.rakeBps,
            side,
            BigInt(baseUnitsFromUsd(b.stakeUsd)),
          );
        } catch {
          /* rpc blip */
        }
      }

      if (!cancelled && Object.keys(multPatches).length > 0) {
        setBets((prev) =>
          prev.map((b) =>
            multPatches[b.offChainMarketId]
              ? { ...b, estimatedMultiple: multPatches[b.offChainMarketId]! }
              : b,
          ),
        );
      }
    };

    void pollOpen();
    const burst = [0, 120, 280].map((ms) => setTimeout(() => void pollOpen(), ms));
    const id = setInterval(pollOpen, CHAIN_ODDS_POLL_OPEN_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      burst.forEach(clearTimeout);
    };
  }, [enabled, chain, openMarkets, applyMarketPool]);

  // Locked bets: keep estimatedMultiple fresh at a calmer cadence.
  useEffect(() => {
    if (!enabled || !chain.ready) return;
    let cancelled = false;
    const pollLocked = async () => {
      const multPatches: Record<string, number> = {};
      for (const b of betsRef.current) {
        if (b.resolvedOutcome) continue;
        const open = openMarketsRef.current.some(
          (m) => m.id === b.offChainMarketId && m.phase === "open",
        );
        if (open) continue;
        try {
          const om = await chain.fetchMarket(b.authority, b.marketSeed);
          if (cancelled || !om || om.status === "Resolved" || om.status === "Void") continue;
          applyMarketPool(b.offChainMarketId, om);
          const side: OnChainSide = b.side === "YES" ? "Yes" : "No";
          multPatches[b.offChainMarketId] = heldBetMultiple(
            om.poolYesLamports,
            om.poolNoLamports,
            om.rakeBps,
            side,
            BigInt(baseUnitsFromUsd(b.stakeUsd)),
          );
        } catch {
          /* rpc blip */
        }
      }
      if (!cancelled && Object.keys(multPatches).length > 0) {
        setBets((prev) =>
          prev.map((b) =>
            multPatches[b.offChainMarketId]
              ? { ...b, estimatedMultiple: multPatches[b.offChainMarketId]! }
              : b,
          ),
        );
      }
    };
    void pollLocked();
    const id = setInterval(pollLocked, CHAIN_ODDS_POLL_LOCKED_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, chain, applyMarketPool]);

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
          const onChainBet = await chain.fetchBet(b.authority, b.marketSeed);
          if (!onChainBet) continue;
          const outcome =
            om.status === "Void"
              ? "VOID"
              : om.outcome === "Yes"
                ? "YES"
                : om.outcome === "No"
                  ? "NO"
                  : b.resolvedOutcome;
          const won = outcome !== "VOID" && b.side === outcome;
          // Exact realized payout from the FINAL on-chain pools (the bet is already counted in
          // the winning pool, so divide by the pool as-is — do NOT add the stake again). VOID =
          // full refund. This is what the session row shows as the real win/loss, not an estimate.
          let realizedUsd: number | undefined;
          if (won) {
            const winPool = b.side === "YES" ? om.poolYesLamports : om.poolNoLamports;
            const stakeBase = BigInt(baseUnitsFromUsd(b.stakeUsd));
            const payoutBase =
              winPool > 0n
                ? (stakeBase * bpsNet(om.poolYesLamports, om.poolNoLamports, om.rakeBps)) / winPool
                : stakeBase;
            realizedUsd = usdFromBaseUnits(payoutBase);
          } else if (outcome === "VOID") {
            realizedUsd = b.stakeUsd;
          }
          updates[b.offChainMarketId] = {
            claimable: true,
            resolvedOutcome: outcome,
            won,
            ...(realizedUsd !== undefined ? { realizedUsd } : {}),
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
    const id = setInterval(poll, 1200);
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
      if (!enabled || !onChain || !chain.ready) return false;
      if (placingMarketId === market.id) return false;
      const { authority, marketSeed } = onChain;
      const stakeBaseUnits = baseUnitsFromUsd(stakeUnits);

      if (stakeUnits < MIN_STAKE_USD) {
        setError(`Minimum bet is $${MIN_STAKE_USD}.`);
        return false;
      }
      const spendable = chain.balanceUsd - reservedStakeRef.current;
      if (spendable < stakeUnits) {
        setError("Low USX balance — fund your wallet in the Wallet tab.");
        return false;
      }
      // No SOL pre-check: bets are sent through Privy native gas sponsorship, so
      // a bettor never needs SOL.
      if (betsRef.current.some((b) => b.offChainMarketId === market.id)) {
        setError("One on-chain bet per market.");
        return false;
      }

      setPlacingMarketId(market.id);
      setError(null);
      reservedStakeRef.current += stakeUnits;
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
        const placedAt = Date.now();

        setBets((prev) => [
          ...prev,
          {
            marketSeed,
            authority,
            offChainMarketId: market.id,
            question: market.question,
            side,
            stakeUsd: stakeUnits,
            placedAt,
            estimatedMultiple: quote.estimatedMultiple,
            betSignature: res.signature,
            betUrl: res.explorerUrl,
            claimable: false,
            claiming: false,
          },
        ]);
        persistOpenBet({
          offChainMarketId: market.id,
          authority,
          marketSeed,
          question: market.question,
          side,
          stakeUsd: stakeUnits,
          placedAt,
        });
        void refreshMarketPool(market.id, authority, marketSeed);
        return true;
      } catch (e) {
        // Sponsored confirm can fail after place_bet lands — recover the on-chain receipt.
        try {
          const existing = await chain.fetchBet(authority, marketSeed);
          if (existing) {
            const om = await chain.fetchMarket(authority, marketSeed);
            if (om) {
              const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
              const quote = chain.quoteBet(om, onChainSide, stakeBaseUnits);
              const placedAt = Date.now();
              setBets((prev) => {
                if (prev.some((b) => b.offChainMarketId === market.id)) return prev;
                return [
                  ...prev,
                  {
                    marketSeed,
                    authority,
                    offChainMarketId: market.id,
                    question: market.question,
                    side,
                    stakeUsd: stakeUnits,
                    placedAt,
                    estimatedMultiple: quote.estimatedMultiple,
                    // Recovery path: the bet account exists but the original confirm path did
                    // not return a signature. Link the recovered bet PDA instead of inventing
                    // a transaction URL.
                    betSignature: `recovered-${existing.address}`,
                    betUrl: chain.explorerAddressUrl(existing.address),
                    claimable: false,
                    claiming: false,
                  },
                ];
              });
              persistOpenBet({
                offChainMarketId: market.id,
                authority,
                marketSeed,
                question: market.question,
                side,
                stakeUsd: stakeUnits,
                placedAt,
              });
              await chain.refreshBalance();
              return true;
            }
          }
        } catch {
          /* recovery probe failed */
        }
        setError(errMsg(e));
        return false;
      } finally {
        reservedStakeRef.current = Math.max(
          0,
          reservedStakeRef.current - stakeUnits,
        );
        setPlacingMarketId((cur) => (cur === market.id ? null : cur));
      }
    },
    [enabled, chain, placingMarketId, twinReady, waitForTwin, refreshMarketPool, persistOpenBet],
  );

  const claimOne = useCallback(
    async (marketId: string) => {
      const bet = betsRef.current.find((b) => b.offChainMarketId === marketId);
      if (!bet || !chain.ready || bet.claiming || bet.claimSignature) return;
      setBetFor(marketId, { claiming: true });
      setError(null);
      try {
        const onChainBet = await chain.fetchBet(bet.authority, bet.marketSeed);
        if (!onChainBet) {
          setError("Bet still confirming on-chain — wait a moment, then tap again.");
          setBetFor(marketId, { claiming: false, claimable: false });
          return;
        }
        if (onChainBet.claimed) {
          store.removeOpenChainBet(marketId);
          setBetFor(marketId, { claiming: false, claimable: false });
          return;
        }
        const market = await chain.fetchMarket(bet.authority, bet.marketSeed);
        if (!market || (market.status !== "Resolved" && market.status !== "Void")) {
          setError("Settlement still finalizing on-chain — claim unlocks in a moment.");
          setBetFor(marketId, { claiming: false });
          return;
        }
        let res = null as Awaited<ReturnType<UseChain["claim"]>> | null;
        let lastErr: unknown = null;
        for (let i = 0; i < 3 && !res; i++) {
          try {
            res = await chain.claim({
              authority: bet.authority,
              marketSeed: bet.marketSeed,
            });
          } catch (e) {
            lastErr = e;
            if (i < 2) await sleep(800);
          }
        }
        if (!res) throw lastErr ?? new Error("Claim failed");
        await chain.refreshBalance();
        store.removeOpenChainBet(marketId);
        setBetFor(marketId, {
          claiming: false,
          claimSignature: res.signature,
          claimUrl: res.explorerUrl,
        });
      } catch (e) {
        const msg = errMsg(e);
        setError(msg);
        if (/confirming on-chain/i.test(msg)) {
          setBetFor(marketId, { claiming: false, claimable: false });
        } else {
          setBetFor(marketId, { claiming: false });
        }
      }
    },
    [chain, setBetFor, store],
  );

  const drainClaimQueue = useCallback(() => {
    if (claimDrainRef.current) return claimDrainRef.current;
    claimDrainRef.current = (async () => {
      while (claimQueueRef.current.length > 0) {
        const marketId = claimQueueRef.current.shift()!;
        await claimOne(marketId);
      }
    })().finally(() => {
      claimDrainRef.current = null;
    });
    return claimDrainRef.current;
  }, [claimOne]);

  const claim = useCallback(
    async (marketId: string) => {
      if (!claimQueueRef.current.includes(marketId)) {
        claimQueueRef.current.push(marketId);
      }
      await drainClaimQueue();
    },
    [drainClaimQueue],
  );

  const claimAll = useCallback(async () => {
    const ids = betsRef.current
      .filter((b) => b.claimable && !b.claimSignature && !b.claiming)
      .map((b) => b.offChainMarketId);
    for (const id of ids) {
      if (!claimQueueRef.current.includes(id)) claimQueueRef.current.push(id);
    }
    await drainClaimQueue();
  }, [drainClaimQueue]);

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

  const dismissReveal = useCallback((marketId: string) => {
    setDismissedReveals((prev) => {
      if (prev.has(marketId)) return prev;
      const next = new Set(prev);
      next.add(marketId);
      return next;
    });
  }, []);

  const isRevealDismissed = useCallback(
    (marketId: string) => dismissedReveals.has(marketId),
    [dismissedReveals],
  );

  const getLiveOdds = useCallback(
    (marketId: string, stakeUsd: number = stake): ChainOdds | null => {
      const c = poolCache[marketId];
      if (!c) return null;
      return oddsFromPool(chain, c, stakeUsd);
    },
    [poolCache, stake, chain],
  );

  const getHeldMultiple = useCallback(
    (marketId: string, side: "YES" | "NO", stakeUsd: number): number | null => {
      const c = poolCache[marketId];
      if (!c || stakeUsd <= 0) return null;
      const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
      const mult = heldBetMultiple(
        c.poolYesLamports,
        c.poolNoLamports,
        c.rakeBps,
        onChainSide,
        BigInt(baseUnitsFromUsd(stakeUsd)),
      );
      return mult > 0 ? mult : null;
    },
    [poolCache],
  );

  return {
    bets,
    placingMarketId,
    error,
    isTwinReady: (id) => !!twinReady[id],
    getLiveOdds,
    getHeldMultiple,
    getBet,
    placeBet,
    claim,
    claimAll,
    markResolved,
    dismissReveal,
    isRevealDismissed,
    clearError: () => setError(null),
  };
}
