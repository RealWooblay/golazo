// REAL on-chain betting for the live match — the bridge between the match UX and
// the deployed parimutuel program.
//
// When the feed runs in CHAIN MODE, each broadcast market carries `onChain`
// ({ marketSeed, authority }) identifying its on-chain twin. This hook lets the
// embedded wallet place a REAL `place_bet` on that twin, then CLAIM after the
// feed operator resolves it. Play-money markets (no `onChain`) are untouched —
// they keep flowing through useGameFeed.
//
// The off-chain market drives the UX (question, countdown, when it resolves);
// the money is 100% on-chain. We show an indicative quote from the live
// on-chain pool, then the PROGRAM pays the final proportional pool share.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketVM } from "@/state/types";
import { LAMPORTS_PER_SOL } from "@/features/chain/config";
import { holdBeforeChainBet } from "@/features/chain/betHold";
import type { UseChain } from "@/features/chain/useChain";
import type { OnChainSide } from "@/features/chain/types";
import { useStore } from "@/state/store";

/** Demo conversion: one stake "unit" (the $10/$25/… chips) → this much SOL. */
const SOL_PER_UNIT = 0.01;
/** Keep a little SOL back for tx fees when checking affordability. */
const FEE_HEADROOM_SOL = 0.01;
/** Poll until the operator's initialize_market tx lands on devnet. */
const CHAIN_TWIN_POLL_MS = 1500;
const CHAIN_TWIN_MAX_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/0x177[c-d]|InsufficientVaultFunds|601[23]/i.test(raw)) {
    return "Vault short on devnet — retry claim in a few seconds (operator topping up).";
  }
  return raw || "On-chain action failed";
};

export interface ChainBetVM {
  marketSeed: number;
  authority: string;
  /** off-chain market id this bet belongs to — used to detect resolution. */
  offChainMarketId: string;
  question: string;
  side: "YES" | "NO";
  stakeSol: number;
  estimatedMultiple: number;
  betSignature: string;
  betUrl: string;
  /** True once the off-chain market has resolved → the on-chain bet can claim. */
  claimable: boolean;
  resolvedOutcome?: "YES" | "NO" | "VOID";
  won?: boolean;
  claiming: boolean;
  claimSignature?: string;
  claimUrl?: string;
}

/** Live indicative odds read from the on-chain pool. */
export interface ChainOdds {
  oddsYes: number;
  oddsNo: number;
  yesShare: number; // 0-100 for the split bar
  poolSol: number;
}

export interface UseChainBet {
  bet: ChainBetVM | null;
  placing: boolean;
  funding: boolean;
  error: string | null;
  /** True when this market is a real on-chain market and the wallet is live. */
  active: boolean;
  /** True once the on-chain twin account exists and bets can land. */
  chainTwinReady: boolean;
  /** On-chain pool odds for the current market (null until the twin is readable). */
  liveOdds: ChainOdds | null;
  placeChainBet: (side: "YES" | "NO", stakeUnits: number) => Promise<void>;
  claimChainBet: () => Promise<void>;
  fundWallet: () => Promise<void>;
  dismiss: () => void;
  clearError: () => void;
}

/**
 * Manage the real on-chain bet for the CURRENT market. `market` is the live
 * off-chain market from useGameFeed; when it carries `onChain` and the wallet is
 * ready, bets are real.
 */
export function useChainBet(
  market: MarketVM | null,
  chain: UseChain,
): UseChainBet {
  const [bet, setBet] = useState<ChainBetVM | null>(null);
  const [placing, setPlacing] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveOdds, setLiveOdds] = useState<ChainOdds | null>(null);
  const [chainTwinReady, setChainTwinReady] = useState(false);
  const marketRef = useRef(market);
  marketRef.current = market;
  const { mode, stake, session } = useStore();

  // Real on-chain betting only in LIVE + REAL money mode. Points mode uses the
  // server-authoritative points pool; demo/offline is play-money.
  const active =
    chain.ready && mode === "live" && session.moneyMode === "real" && !!market?.onChain;
  const seed = market?.onChain?.marketSeed;
  const auth = market?.onChain?.authority;

  // New market → clear stale errors from the previous twin.
  useEffect(() => {
    setError(null);
    setChainTwinReady(false);
  }, [market?.id, seed]);

  // Poll until the operator's initialize_market lands so bets don't hit a missing PDA.
  useEffect(() => {
    if (!active || seed === undefined || !auth) {
      setChainTwinReady(false);
      return;
    }
    let cancelled = false;
    const started = Date.now();
    const poll = async () => {
      try {
        const m = await chain.fetchMarket(auth, seed);
        if (cancelled) return;
        if (m) {
          setChainTwinReady(true);
          return;
        }
        if (Date.now() - started > CHAIN_TWIN_MAX_WAIT_MS) {
          setError(
            "On-chain market is taking longer than usual — tap bet again or use play-money.",
          );
        }
      } catch {
        /* transient RPC blip */
      }
    };
    void poll();
    const id = setInterval(poll, CHAIN_TWIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, seed, auth, chain]);

  // Poll the on-chain pool so the card shows the REAL indicative odds for the
  // selected stake (not the bot-inflated off-chain pool). Stops once a bet is
  // placed / market gone.
  useEffect(() => {
    if (!active || seed === undefined || !auth || bet || !chainTwinReady) {
      if (!bet) setLiveOdds(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const m = await chain.fetchMarket(auth, seed);
        if (cancelled || !m) return;
        const py = Number(m.poolYesLamports);
        const pn = Number(m.poolNoLamports);
        const grossLamports = py + pn;
        const stakeLamports = Math.round(
          stake * SOL_PER_UNIT * LAMPORTS_PER_SOL,
        );
        setLiveOdds({
          oddsYes: chain.quoteBet(m, "Yes", stakeLamports).estimatedMultiple,
          oddsNo: chain.quoteBet(m, "No", stakeLamports).estimatedMultiple,
          yesShare: grossLamports > 0 ? (100 * py) / grossLamports : 50,
          poolSol: grossLamports / LAMPORTS_PER_SOL,
        });
      } catch {
        /* transient RPC blip — keep last odds */
      }
    };
    void poll();
    const id = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, seed, auth, bet, chain, stake, chainTwinReady]);

  // RESOLUTION: when our bet's off-chain market is no longer the one on screen
  // (it resolved → setMarket(null), or a new market opened), the on-chain twin
  // has been resolved by the operator, so the bet becomes claimable.
  useEffect(() => {
    if (bet && !bet.claimable && market?.id !== bet.offChainMarketId) {
      setBet((b) => (b ? { ...b, claimable: true } : b));
    }
  }, [market?.id, bet]);

  const fundWallet = useCallback(async () => {
    if (!chain.ready || !chain.airdropEnabled) {
      setError("Funding is only available on devnet / localnet.");
      return;
    }
    setFunding(true);
    setError(null);
    try {
      await chain.airdrop(2);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setFunding(false);
    }
  }, [chain]);

  const waitForChainTwin = useCallback(async (): Promise<boolean> => {
    if (!auth || seed === undefined) return false;
    const deadline = Date.now() + CHAIN_TWIN_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const m = await chain.fetchMarket(auth, seed);
      if (m) {
        setChainTwinReady(true);
        return true;
      }
      await sleep(CHAIN_TWIN_POLL_MS);
    }
    return false;
  }, [auth, seed, chain]);

  const placeChainBet = useCallback(
    async (side: "YES" | "NO", stakeUnits: number) => {
      const onChain = market?.onChain;
      if (!onChain || !chain.ready || placing) return;
      const { authority, marketSeed } = onChain;
      const stakeSol = stakeUnits * SOL_PER_UNIT;
      const stakeLamports = Math.round(stakeSol * LAMPORTS_PER_SOL);

      if (chain.balanceSol < stakeSol + FEE_HEADROOM_SOL) {
        setError(`Low balance — fund your wallet in the Wallet tab.`);
        return;
      }

      setPlacing(true);
      setError(null);
      try {
        let ready = chainTwinReady;
        if (!ready) {
          setError("Preparing on-chain market…");
          ready = await waitForChainTwin();
        }
        if (!ready) {
          setError(
            "On-chain market not ready yet — wait a moment and tap again.",
          );
          return;
        }

        const hold = await holdBeforeChainBet(
          () =>
            marketRef.current?.id === market.id &&
            marketRef.current?.phase === "open",
        );
        if (!hold.ok) {
          setError(hold.reason ?? "Bet not accepted");
          return;
        }

        const m = await chain.fetchMarket(authority, marketSeed);
        if (!m) {
          setError("On-chain market not found — tap bet again in a moment.");
          setChainTwinReady(false);
          return;
        }

        const onChainSide: OnChainSide = side === "YES" ? "Yes" : "No";
        const quote = chain.quoteBet(m, onChainSide, stakeLamports);
        const res = await chain.placeBetOnChain({
          authority,
          marketSeed,
          side: onChainSide,
          stakeLamports,
        });
        setError(null);
        setBet({
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
        });
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setPlacing(false);
      }
    },
    [market, chain, placing, chainTwinReady, waitForChainTwin],
  );

  const claimChainBet = useCallback(async () => {
    if (!bet || !chain.ready || bet.claiming || bet.claimSignature) return;
    setBet((b) => (b ? { ...b, claiming: true } : b));
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
      setBet((b) =>
        b
          ? {
              ...b,
              claiming: false,
              claimSignature: res!.signature,
              claimUrl: res!.explorerUrl,
            }
          : b,
      );
      setError(null);
    } catch (e) {
      setError(errMsg(e));
      setBet((b) => (b ? { ...b, claiming: false } : b));
    }
  }, [bet, chain]);

  const dismiss = useCallback(() => setBet(null), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    bet,
    placing,
    funding,
    error,
    active,
    chainTwinReady,
    liveOdds,
    placeChainBet,
    claimChainBet,
    fundWallet,
    dismiss,
    clearError,
  };
}
