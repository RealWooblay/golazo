/**
 * useChain() — the ONE clean React surface for the on-chain layer.
 *
 * THE LAZY CONTRACT (this is the whole point):
 *   Importing this file pulls in NOTHING heavy. `@solana/web3.js`,
 *   `@coral-xyz/anchor`, the embedded keypair, the polyfills, and the client
 *   helpers are all loaded via a DYNAMIC `import('./provider')` /
 *   `import('./client')` that only runs when on-chain mode is actually turned
 *   on (`connect()` is called). So a screen can `import { useChain } from
 *   '@/features/chain'` and still render on web in sandbox with zero chain code
 *   in its bundle.
 *
 * READINESS / FALLBACK:
 *   • `chainConfig.ok === false` (the default) → `ready` stays false, `connect`
 *     is a no-op that records the reason. Callers fall back to sandbox.
 *   • Any runtime failure (bad RPC, undeployed program, storage error) →
 *     `status: 'error'`, `ready: false`. Same fallback.
 *
 * STORE INTEGRATION:
 *   On a successful connect we publish the embedded wallet into the global store
 *   (`setWallet({ connected: true, walletKind: 'embedded', address })`) so the
 *   wallet feature's `useDepositAddress()` resolves the real pubkey — WITHOUT
 *   the wallet screen ever importing this feature. On disconnect we revert the
 *   store to the sandbox wallet.
 *
 * SHAPE returned (superset of the `{ ready, address? }` contract the wallet
 * feature documents in `features/wallet/address.ts`):
 *   { ready, status, reason, address, balanceSol, balanceLamports, cluster,
 *     connect, disconnect, refreshBalance, airdrop, withdrawSol,
 *     placeBetOnChain, claim, quoteBet, fetchMarket, fetchBet, derivePdas,
 *     explorerAddressUrl }
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useStore } from "@/state/store";
import { chainConfig } from "./config";
import type {
  BetAccount,
  BetQuote,
  ClaimArgs,
  MarketAccount,
  MarketPdas,
  OnChainOutcome,
  OnChainSide,
  PlaceBetArgs,
  TxResult,
  WalletInfo,
} from "./types";

// Type-only imports of the lazily-loaded modules. `import type` is erased at
// compile time, so these add NOTHING to the bundle — the runtime values come
// exclusively from the dynamic `import()`s inside `connect()`.
import type {
  ChainContext,
  PrivyRawSigner,
  PrivySignerState,
} from "./provider";
import type * as ClientModule from "./client";
// Platform-split hook: web → the Privy embedded wallet; native → 'legacy'.
// `import type` above stays erased; this is the only runtime import, and it
// pulls NO web3 (the heavy code remains behind the lazy import in connect()).
import { usePrivyChainSigner } from "./usePrivyChainSigner";

type Client = typeof ClientModule;

export type ChainStatus = "idle" | "connecting" | "ready" | "error";

export interface UseChain {
  /** True only when fully connected (wallet + program live). The fallback gate. */
  ready: boolean;
  status: ChainStatus;
  /** Why on-chain mode is unavailable / why a connect failed (for debug UI). */
  reason?: string;
  /** True when config permits even attempting on-chain mode (env flag + program). */
  configured: boolean;

  /** Embedded wallet pubkey (base58) once connected — the deposit address. */
  address?: string;
  balanceSol: number;
  balanceLamports: bigint;
  cluster: typeof chainConfig.cluster;
  /** Devnet faucet allowed? (gates the airdrop button.) */
  airdropEnabled: boolean;

  // lifecycle
  /** Turn on on-chain mode: load libs, open the wallet, publish to the store. */
  connect: () => Promise<boolean>;
  /** Turn it off: revert the store to the sandbox wallet. (Key is NOT destroyed.) */
  disconnect: () => void;
  /** Re-read the embedded wallet's SOL balance. */
  refreshBalance: () => Promise<WalletInfo | null>;

  // money
  /** Devnet airdrop into the embedded wallet (the simplest deposit). */
  airdrop: (sol: number) => Promise<TxResult>;
  /** Send SOL out of the embedded wallet to an external address (cash out). */
  withdrawSol: (toAddress: string, sol: number) => Promise<TxResult>;

  // betting
  placeBetOnChain: (args: PlaceBetArgs) => Promise<TxResult>;
  claim: (args: ClaimArgs) => Promise<TxResult>;
  /** Pure bps preview of indicative multiple/payout. No network. */
  quoteBet: (
    market: Pick<
      MarketAccount,
      "poolYesLamports" | "poolNoLamports" | "rakeBps"
    >,
    side: OnChainSide,
    stakeLamports: bigint | number,
  ) => BetQuote;

  // reads
  fetchMarket: (
    authority: string,
    marketSeed: bigint | number,
  ) => Promise<MarketAccount | null>;
  fetchBet: (
    authority: string,
    marketSeed: bigint | number,
    bettor?: string,
  ) => Promise<BetAccount | null>;
  derivePdas: (
    authority: string,
    marketSeed: bigint | number,
    bettor?: string,
  ) => MarketPdas;

  /** Cluster-aware explorer URL for an address (receipts / "view on explorer"). */
  explorerAddressUrl: (address: string) => string;

  // operator (devnet self-host / QA) — present but only useful with authority funds
  initializeMarket: Client["initializeMarket"] extends (
    ctx: ChainContext,
    ...rest: infer R
  ) => infer Ret
    ? (...args: R) => Ret
    : never;
  resolveMarket: (
    marketSeed: bigint | number,
    outcome: Exclude<OnChainOutcome, "None">,
  ) => Promise<TxResult>;
  lockMarket: (marketSeed: bigint | number) => Promise<TxResult>;
  voidMarket: (marketSeed: bigint | number) => Promise<TxResult>;
}

const NOT_READY = (): never => {
  throw new Error(
    "Chain is not connected. Call connect() and check `ready` first.",
  );
};

const ChainContextReact = createContext<UseChain | null>(null);

/**
 * Provider. Mount it ABOVE any consumer of `useChain()` (e.g. in the root
 * layout, INSIDE the StoreProvider so we can publish the wallet to the store).
 * It's cheap: it loads nothing heavy until `connect()` runs.
 */
export function ChainProvider({
  children,
  autoConnect = false,
}: {
  children: React.ReactNode;
  /** If true, attempt connect on mount when config is ok (default off — opt-in). */
  autoConnect?: boolean;
}) {
  const { setWallet, wallet, hydrated } = useStore();

  // The Privy auth state decides the wallet source: on web, the signed-in user's
  // Privy embedded wallet; on native / Privy-off, the legacy local keypair. Held
  // in a ref so connect() always reads the latest without being recreated.
  const privyState = usePrivyChainSigner();
  const privyStateRef = useRef<PrivySignerState>(privyState);
  privyStateRef.current = privyState;
  // The wallet "key" we're currently connected with — to detect sign-in / out /
  // wallet-switch and reconnect (or disconnect) accordingly.
  const connectedKeyRef = useRef<string | null>(null);

  const [status, setStatus] = useState<ChainStatus>("idle");
  const [reason, setReason] = useState<string | undefined>(
    chainConfig.ok ? undefined : chainConfig.reason,
  );
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [balanceLamports, setBalanceLamports] = useState<bigint>(0n);
  const [balanceSol, setBalanceSol] = useState<number>(0);

  // Heavy modules + the live context live in refs (never re-render on identity).
  const ctxRef = useRef<ChainContext | null>(null);
  const clientRef = useRef<Client | null>(null);
  const connectingRef = useRef<Promise<boolean> | null>(null);

  const requireCtx = useCallback((): { ctx: ChainContext; client: Client } => {
    if (!ctxRef.current || !clientRef.current) NOT_READY();
    return {
      ctx: ctxRef.current as ChainContext,
      client: clientRef.current as Client,
    };
  }, []);

  const refreshBalance = useCallback(async (): Promise<WalletInfo | null> => {
    if (!ctxRef.current || !clientRef.current) return null;
    try {
      const { balanceLamports: lam, balanceSol: sol } =
        await clientRef.current.fetchBalance(ctxRef.current);
      setBalanceLamports(lam);
      setBalanceSol(sol);
      return {
        address: ctxRef.current.wallet.address,
        balanceLamports: lam,
        balanceSol: sol,
      };
    } catch {
      return null; // best-effort; play money
    }
  }, []);

  // Connect with an EXPLICIT wallet source. `privySigner` present → the Privy
  // embedded wallet (web); absent → the legacy local keypair (native). The
  // public `connect` below resolves the source from the current Privy state.
  const runConnect = useCallback(
    async (privySigner?: PrivyRawSigner): Promise<boolean> => {
      if (connectingRef.current) return connectingRef.current;
      if (!chainConfig.ok) {
        setStatus("error");
        setReason(chainConfig.reason);
        return false;
      }

      const run = (async (): Promise<boolean> => {
        setStatus("connecting");
        setReason(undefined);
        try {
          // ── THE LAZY GATE ── nothing heavy loads until this point.
          const provider = await import("./provider");
          const client = await import("./client");
          const built = await provider.buildChainContext(privySigner);
          if (!built.ok) {
            setStatus("error");
            setReason(built.reason);
            return false;
          }
          ctxRef.current = built.context;
          clientRef.current = client;

          const addr = built.context.wallet.address;
          setAddress(addr);
          setStatus("ready");

          // Publish the wallet to the global store so the wallet feature
          // (useDepositAddress) shows the real pubkey. Done through the store
          // contract — the wallet screen never imports this feature.
          setWallet({ connected: true, walletKind: "embedded", address: addr });

          // Kick off an initial balance read (non-blocking for readiness).
          void refreshBalance();
          return true;
        } catch (e) {
          setStatus("error");
          setReason(
            e instanceof Error ? e.message : "Failed to connect to the chain.",
          );
          return false;
        } finally {
          connectingRef.current = null;
        }
      })();

      connectingRef.current = run;
      return run;
    },
    [setWallet, refreshBalance],
  );

  // Public connect: use whatever the current Privy state dictates. In 'pending'
  // mode (Privy on, not signed in) it's a no-op — the UI routes the user to sign
  // in rather than mint a throwaway local wallet on web.
  const connect = useCallback(async (): Promise<boolean> => {
    const st = privyStateRef.current;
    if (st.mode === "pending") return false;
    return runConnect(st.mode === "privy" ? st.signer : undefined);
  }, [runConnect]);

  const disconnect = useCallback(() => {
    ctxRef.current = null;
    clientRef.current = null;
    connectedKeyRef.current = null;
    setStatus("idle");
    setAddress(undefined);
    setBalanceLamports(0n);
    setBalanceSol(0);
    // Revert the store to the sandbox wallet (don't destroy the key — reconnect
    // later returns the same address).
    setWallet({ connected: false, walletKind: "sandbox", address: undefined });
  }, [setWallet]);

  // Restore the persisted wallet address immediately so the UI doesn't flash a
  // new pubkey on refresh while connect() loads the secret from storage.
  useEffect(() => {
    if (!hydrated) return;
    // On web with Privy, the Privy wallet address is authoritative — never flash
    // a stale local-keypair address. Only restore for the legacy (native) path.
    if (privyState.mode !== "legacy") return;
    let alive = true;
    (async () => {
      try {
        const walletMod = await import("./wallet");
        const addr = await walletMod.EmbeddedWallet.peekAddress();
        if (!alive || !addr) return;
        if (wallet.address === addr && wallet.walletKind === "embedded") return;
        setWallet({
          connected: true,
          walletKind: "embedded",
          address: addr,
        });
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrated, privyState.mode, setWallet, wallet.address, wallet.walletKind]);

  // Sync the chain connection to the wallet source. This is the heart of the
  // "seamless, no web3" account flow:
  //   • privy   — signed in (web): connect with the Privy wallet; reconnect if
  //               the wallet address changes (account switch).
  //   • pending — Privy on, not signed in (web): stay disconnected (real mode
  //               gates on login), and tear down any prior connection.
  //   • legacy  — native / Privy-off: the original opt-in autoConnect (one shot),
  //               using the local keypair.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!hydrated || !chainConfig.ok) return;
    const st = privyState;

    if (st.mode === "pending") {
      if (status === "ready" || status === "connecting") disconnect();
      return;
    }

    if (st.mode === "legacy") {
      if (autoConnected.current || status !== "idle") return;
      const shouldAuto =
        autoConnect || (wallet.connected && wallet.walletKind === "embedded");
      if (!shouldAuto) return;
      autoConnected.current = true;
      connectedKeyRef.current = "legacy";
      void runConnect();
      return;
    }

    // privy: connect (or reconnect on wallet switch).
    if (status === "connecting") return;
    const key = `privy:${st.signer.address}`;
    if (status === "ready" && connectedKeyRef.current === key) return;
    connectedKeyRef.current = key;
    void runConnect(st.signer);
  }, [
    hydrated,
    privyState,
    status,
    autoConnect,
    wallet.connected,
    wallet.walletKind,
    runConnect,
    disconnect,
  ]);

  // Keep the on-chain balance fresh while connected. The wallet can be funded
  // externally (SOL sent to the deposit address) with no in-app action to
  // trigger a read, and the single post-connect read can lose a race with a
  // slow / rate-limited devnet RPC — either way the balance would otherwise sit
  // at a stale 0 and every header shows $0. A light poll converges it. Only runs
  // in real chain mode (status 'ready'); sandbox/web never starts a timer.
  useEffect(() => {
    if (status !== "ready") return;
    void refreshBalance();
    const id = setInterval(() => void refreshBalance(), 12_000);
    return () => clearInterval(id);
  }, [status, refreshBalance]);

  const value = useMemo<UseChain>(() => {
    return {
      ready: status === "ready",
      status,
      reason,
      configured: chainConfig.ok,
      address,
      balanceSol,
      balanceLamports,
      cluster: chainConfig.cluster,
      airdropEnabled: chainConfig.airdropEnabled,

      connect,
      disconnect,
      refreshBalance,

      airdrop: async (sol: number) => {
        const { ctx, client } = requireCtx();
        const res = await client.requestAirdrop(ctx, sol);
        await refreshBalance();
        return res;
      },
      withdrawSol: async (toAddress: string, sol: number) => {
        const { ctx, client } = requireCtx();
        const res = await client.withdrawSol(ctx, toAddress, sol);
        await refreshBalance();
        return res;
      },

      placeBetOnChain: async (args: PlaceBetArgs) => {
        const { ctx, client } = requireCtx();
        const res = await client.placeBet(ctx, args);
        await refreshBalance();
        return res;
      },
      claim: async (args: ClaimArgs) => {
        const { ctx, client } = requireCtx();
        const res = await client.claim(ctx, args);
        await refreshBalance();
        return res;
      },
      quoteBet: (market, side, stakeLamports) => {
        const { client } = requireCtx();
        return client.quoteBet(market, side, stakeLamports);
      },

      fetchMarket: async (authority, marketSeed) => {
        const { ctx, client } = requireCtx();
        return client.fetchMarket(ctx, authority, marketSeed);
      },
      fetchBet: async (authority, marketSeed, bettor) => {
        const { ctx, client } = requireCtx();
        return client.fetchBet(ctx, authority, marketSeed, bettor);
      },
      derivePdas: (authority, marketSeed, bettor) => {
        const { ctx, client } = requireCtx();
        return client.deriveMarketPdas(ctx, authority, marketSeed, bettor);
      },

      explorerAddressUrl: (addr: string) => {
        // No need for a live ctx — pure string build off the resolved cluster.
        // (provider.explorerAddressUrl is also re-exported from the barrel.)
        const cluster = chainConfig.cluster;
        const base = `https://explorer.solana.com/address/${addr}`;
        if (cluster === "mainnet-beta") return base;
        return `${base}?cluster=${cluster === "localnet" ? "custom" : cluster}`;
      },

      initializeMarket: (async (
        params: Parameters<Client["initializeMarket"]>[1],
      ) => {
        const { ctx, client } = requireCtx();
        return client.initializeMarket(ctx, params);
      }) as UseChain["initializeMarket"],
      resolveMarket: async (marketSeed, outcome) => {
        const { ctx, client } = requireCtx();
        return client.resolveMarket(ctx, marketSeed, outcome);
      },
      lockMarket: async (marketSeed) => {
        const { ctx, client } = requireCtx();
        return client.lockMarket(ctx, marketSeed);
      },
      voidMarket: async (marketSeed) => {
        const { ctx, client } = requireCtx();
        return client.voidMarket(ctx, marketSeed);
      },
    };
  }, [
    status,
    reason,
    address,
    balanceSol,
    balanceLamports,
    connect,
    disconnect,
    refreshBalance,
    requireCtx,
  ]);

  return (
    <ChainContextReact.Provider value={value}>
      {children}
    </ChainContextReact.Provider>
  );
}

/**
 * Access the chain surface. Works WITHOUT a provider too: if no `ChainProvider`
 * is mounted, returns a stable, inert "not configured" object so callers (e.g. a
 * web sandbox build) can call `useChain()` unconditionally and just see
 * `ready: false`. This keeps the fallback ergonomics dead simple.
 */
export function useChain(): UseChain {
  const ctx = useContext(ChainContextReact);
  return ctx ?? INERT_CHAIN;
}

/** The inert surface returned when no ChainProvider is mounted. */
const INERT_CHAIN: UseChain = {
  ready: false,
  status: "idle",
  reason: "ChainProvider is not mounted (sandbox mode).",
  configured: chainConfig.ok,
  address: undefined,
  balanceSol: 0,
  balanceLamports: 0n,
  cluster: chainConfig.cluster,
  airdropEnabled: chainConfig.airdropEnabled,
  connect: async () => false,
  disconnect: () => {},
  refreshBalance: async () => null,
  airdrop: NOT_READY,
  withdrawSol: NOT_READY,
  placeBetOnChain: NOT_READY,
  claim: NOT_READY,
  quoteBet: NOT_READY,
  fetchMarket: NOT_READY,
  fetchBet: NOT_READY,
  derivePdas: NOT_READY,
  explorerAddressUrl: (addr: string) =>
    `https://explorer.solana.com/address/${addr}`,
  initializeMarket: NOT_READY as unknown as UseChain["initializeMarket"],
  resolveMarket: NOT_READY,
  lockMarket: NOT_READY,
  voidMarket: NOT_READY,
};
