/**
 * CHAIN CONFIG — the single source of truth for *where* the on-chain layer
 * points. Everything here is env-driven with a safe **devnet** default, so the
 * app runs against Solana devnet out of the box but can be repointed (localnet,
 * a custom RPC, or a freshly-deployed program id) without touching code.
 *
 * WHY this is its own tiny module (no heavy imports):
 *   This file is imported by `useChain()` *eagerly* to decide whether on-chain
 *   mode is even possible — so it MUST stay free of `@solana/web3.js`,
 *   `@coral-xyz/anchor`, or any native polyfill. It only reads strings/enums.
 *   The heavy libs are dynamically imported elsewhere, behind the lazy gate.
 *
 * ENV (via `expo-constants` → app.json `extra`, or `process.env.EXPO_PUBLIC_*`):
 *   EXPO_PUBLIC_SOLANA_CLUSTER    'devnet' | 'mainnet-beta' | 'testnet' | 'localnet'
 *   EXPO_PUBLIC_SOLANA_RPC_URL    optional dev override (never put API keys here)
 *   EXPO_PUBLIC_GOLAZO_PROGRAM_ID base58 program id of the deployed program
 *   EXPO_PUBLIC_CHAIN_ENABLED     '1' | 'true' to allow on-chain mode at all
 *
 * NOTHING here throws. If config is missing/invalid we surface it as
 * `chainConfig.ok === false` and `useChain()` reports `ready=false` so callers
 * transparently fall back to sandbox / play-money mode.
 */

import Constants from "expo-constants";
import { defaultSolanaRpcUrl } from "@/lib/config";

export type Cluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

/**
 * The placeholder program id baked into the Anchor program's `declare_id!`
 * (see programs/golazo-parimutuel/src/lib.rs). It is intentionally NOT a real
 * deployed key — after `anchor build && anchor keys sync` you redeploy and set
 * `EXPO_PUBLIC_GOLAZO_PROGRAM_ID` to the printed key. Until then we treat the
 * placeholder as "no program deployed" → on-chain mode stays unavailable.
 */
export const PLACEHOLDER_PROGRAM_ID =
  "Go1azoPariMutue11111111111111111111111111111";

/**
 * The REAL deployed program id (synced to declare_id! + the program keypair).
 * Verified deployed + a full init→bet→resolve→claim lifecycle run on a local
 * validator on 2026-06-19 (rake residual = 6.00% of gross, on-chain). It's the
 * default target when EXPO_PUBLIC_GOLAZO_PROGRAM_ID isn't set. To point the app
 * at a live deployment, set the matching cluster:
 *   - localnet: EXPO_PUBLIC_SOLANA_CLUSTER=localnet (a `solana-test-validator`
 *     with this program deployed)
 *   - devnet:   deploy there (`solana program deploy …`) once funded, default cluster.
 */
export const DEPLOYED_PROGRAM_ID =
  "3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM";

/**
 * Public cluster RPC endpoints (no API keys). Mainnet uses the feed `/rpc`
 * proxy via {@link defaultSolanaRpcUrl} so Helius/QuickNode keys stay server-side.
 */
const CLUSTER_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** 1 SOL = 1e9 lamports. The unit the program speaks in. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Treasury wallet that collects the rake/trade fees on-chain. The rake accrues in
 * each market's vault (it's never paid out to bettors); the operator sweeps it to
 * this address. Override with EXPO_PUBLIC_FEE_RECIPIENT.
 */
export const DEFAULT_FEE_RECIPIENT =
  "5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP";

// ── USX settlement asset ───────────────────────────────────────────────────────
// The program settles in USX (SPL classic), NOT native SOL. Every on-chain amount
// (stake / pool / payout / balance) is in USX *base units*. SOL is only used to
// pay transaction fees from the embedded wallet.

/** The USX mint (matches `USX_MINT` in the program). Override: EXPO_PUBLIC_USX_MINT. */
export const DEFAULT_USX_MINT = "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG";

/** USX has 6 decimals, so $1 = 1 USX = 1e6 base units. */
export const USX_DECIMALS = 6;
export const USX_BASE_UNITS_PER_DOLLAR = 1_000_000;

/** SPL Token + Associated Token program ids (constant across clusters). */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Stake-chip dollars → USX base units (the unit the program speaks). */
export const baseUnitsFromUsd = (usd: number): number =>
  Math.round(usd * USX_BASE_UNITS_PER_DOLLAR);

/** USX base units → display dollars (1 USX == $1). */
export const usdFromBaseUnits = (baseUnits: bigint | number): number =>
  Number(baseUnits) / USX_BASE_UNITS_PER_DOLLAR;

/** Canonical PDA seed prefixes — MUST match `instructions::seeds` in the program. */
export const SEEDS = {
  MARKET: "market",
  VAULT: "vault",
  BET: "bet",
} as const;

/** Read an env var from EXPO_PUBLIC_* first, then app.json `extra`. */
function readEnv(key: string): string | undefined {
  // process.env.EXPO_PUBLIC_* is inlined by Metro at build time (web-safe).
  const fromProcess =
    typeof process !== "undefined"
      ? (process.env?.[`EXPO_PUBLIC_${key}`] as string | undefined)
      : undefined;
  if (fromProcess && fromProcess.length > 0) return fromProcess;
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const fromExtra = extra[key];
  return typeof fromExtra === "string" && fromExtra.length > 0
    ? fromExtra
    : undefined;
}

function readCluster(): Cluster {
  // Default mainnet-beta: this app ships configured for mainnet. Local dev points
  // elsewhere via app.json `extra` (SOLANA_CLUSTER), the reliable web config source.
  const raw = (readEnv("SOLANA_CLUSTER") ?? "mainnet-beta").toLowerCase();
  if (
    raw === "devnet" ||
    raw === "testnet" ||
    raw === "mainnet-beta" ||
    raw === "localnet"
  ) {
    return raw;
  }
  return "devnet";
}

/** A truthy env flag is required to even *attempt* on-chain mode. */
function readEnabled(): boolean {
  const raw = (readEnv("CHAIN_ENABLED") ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Cheap base58 program-id sanity check (no web3 import). 32–44 base58 chars. */
function looksLikePubkey(s: string | undefined): s is string {
  if (!s) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export interface ChainConfig {
  /** True only when on-chain mode is *configured* (enabled + real program id). */
  readonly ok: boolean;
  /** Human reason when `ok === false` — surfaced in the README/debug, never thrown. */
  readonly reason?: string;
  readonly cluster: Cluster;
  readonly rpcUrl: string;
  readonly programId: string;
  /** USX mint the program settles in (base58). */
  readonly usxMint: string;
  /** Treasury wallet the rake/fees are swept to. */
  readonly feeRecipient: string;
  /** Devnet airdrops are allowed; mainnet never. Used to gate the faucet button. */
  readonly airdropEnabled: boolean;
}

/**
 * Resolve the chain config once at module load. Pure string/enum work — safe to
 * import anywhere. `ok` gates whether `useChain()` will even try to load web3.
 */
function resolveRpcUrl(cluster: Cluster): string {
  const explicit = readEnv("SOLANA_RPC_URL");
  if (explicit && !explicit.includes("api-key=")) return explicit;
  if (cluster === "mainnet-beta") return defaultSolanaRpcUrl();
  return CLUSTER_RPC[cluster];
}

export function resolveChainConfig(): ChainConfig {
  const cluster = readCluster();
  const rpcUrl = resolveRpcUrl(cluster);
  const enabled = readEnabled();
  const programId = readEnv("GOLAZO_PROGRAM_ID") ?? DEPLOYED_PROGRAM_ID;
  const usxMint = readEnv("USX_MINT") ?? DEFAULT_USX_MINT;
  const feeRecipient = readEnv("FEE_RECIPIENT") ?? DEFAULT_FEE_RECIPIENT;
  const airdropEnabled =
    cluster === "devnet" || cluster === "testnet" || cluster === "localnet";

  let ok = true;
  let reason: string | undefined;

  if (!enabled) {
    ok = false;
    reason =
      "On-chain mode is off (set EXPO_PUBLIC_CHAIN_ENABLED=1 to enable).";
  } else if (!looksLikePubkey(programId)) {
    ok = false;
    reason = "EXPO_PUBLIC_GOLAZO_PROGRAM_ID is not a valid base58 pubkey.";
  } else if (programId === PLACEHOLDER_PROGRAM_ID) {
    ok = false;
    reason =
      "No real program id configured — the program has not been deployed yet " +
      "(still the declare_id! placeholder). Deploy + set EXPO_PUBLIC_GOLAZO_PROGRAM_ID.";
  }

  return {
    ok,
    reason,
    cluster,
    rpcUrl,
    programId,
    usxMint,
    feeRecipient,
    airdropEnabled,
  };
}

/** The resolved config, computed once. */
export const chainConfig: ChainConfig = resolveChainConfig();
