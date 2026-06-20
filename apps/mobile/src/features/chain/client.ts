/**
 * ON-CHAIN CLIENT — typed helpers that mirror every instruction + account of the
 * `golazo_parimutuel` program, plus account reads and the airdrop faucet.
 *
 * RAW web3 (NOT the Anchor method namespace): instructions are built from the
 * program's anchor discriminators (`sha256("global:<ix>")[..8]`, hard-coded as
 * verified constants) + borsh-encoded args + the exact account orderings from
 * the program's `#[derive(Accounts)]` structs. Reads decode the raw account
 * buffers directly. This is the SAME approach proven in the on-chain demo + the
 * feed operator, and it removes all dependence on Anchor's IDL/method casing
 * (which differs across Anchor versions and silently broke `place_bet`).
 *
 * DESIGN
 *   • Each helper takes the {@link ChainContext} first, then domain args. The
 *     hook curries the context away so callers see a clean `placeBetOnChain(args)`.
 *   • All sends go through `ctx.provider.sendAndConfirm`, which signs with the
 *     embedded wallet (the bettor / operator) and confirms.
 *   • `quoteBet` is pure bps math (mirror of the program), so the app can show a
 *     stake-aware estimated payout without promising fixed odds.
 */

import { Buffer } from "buffer";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

import {
  indicativeMultipleBps,
  indicativePayout,
  bpsToMultiple,
} from "./bps";
import { deriveBetPda, deriveMarketPda, deriveVaultPda } from "./pdas";
import { explorerTxUrl, type ChainContext } from "./provider";
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
} from "./types";

// ── anchor discriminators (sha256("global:<ix>")[..8]) ──────────────────────────
// Verified against the deployed program. Hard-coded so we need no hashing at
// runtime and no IDL method lookup.
const DISC = {
  initialize_market: [35, 35, 189, 193, 155, 48, 170, 203],
  place_bet: [222, 62, 67, 220, 63, 166, 126, 33],
  lock_market: [107, 8, 184, 91, 223, 13, 180, 38],
  resolve_market: [155, 23, 80, 173, 46, 74, 23, 239],
  void_market: [243, 175, 46, 124, 95, 101, 39, 69],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
} as const;

// Side {Yes=0, No=1}; Outcome {None=0, Yes=1, No=2} — borsh enum variant indices.
const sideByte = (s: OnChainSide): number => (s === "Yes" ? 0 : 1);
const outcomeByte = (o: OnChainOutcome): number =>
  o === "Yes" ? 1 : o === "No" ? 2 : 0;

// ── small encoders ────────────────────────────────────────────────────────────

/** u64 (bigint|number) → 8-byte little-endian Buffer. */
function u64le(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
/** u16 → 2-byte little-endian Buffer. */
function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
const disc = (name: keyof typeof DISC): Buffer => Buffer.from(DISC[name]);

const meta = (
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): AccountMeta => ({ pubkey, isSigner, isWritable });

/** Build + sign + send a single-instruction tx with the embedded wallet. */
async function send(
  ctx: ChainContext,
  keys: AccountMeta[],
  data: Buffer,
): Promise<TxResult> {
  const ix = new TransactionInstruction({ programId: ctx.programId, keys, data });
  const tx = new Transaction().add(ix);
  const signature = await ctx.provider.sendAndConfirm(tx, []);
  return { signature, explorerUrl: explorerTxUrl(signature, ctx.config.cluster) };
}

/** 32-byte question hash buffer → hex string (for the decoded account). */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const STATUS = ["Open", "Locked", "Resolved", "Void"] as const;
const OUTCOME = ["None", "Yes", "No"] as const;

// ── PDA helpers (re-exported through the context's program id) ──────────────────

/** All PDAs for a market (and optionally the caller's bet PDA), as base58. */
export function deriveMarketPdas(
  ctx: ChainContext,
  authority: string,
  marketSeed: bigint | number,
  bettor?: string,
): MarketPdas {
  const authorityPk = new PublicKey(authority);
  const [market] = deriveMarketPda(ctx.programId, authorityPk, marketSeed);
  const [vault] = deriveVaultPda(ctx.programId, market);
  const bet = bettor
    ? deriveBetPda(ctx.programId, market, new PublicKey(bettor))[0]
    : undefined;
  return {
    market: market.toBase58(),
    vault: vault.toBase58(),
    bet: bet?.toBase58(),
  };
}

// ── reads (raw account-buffer decode) ───────────────────────────────────────────

/** Embedded wallet SOL balance (lamports + SOL). */
export async function fetchBalance(
  ctx: ChainContext,
): Promise<{ balanceLamports: bigint; balanceSol: number }> {
  const lamports = await ctx.connection.getBalance(
    ctx.wallet.publicKey,
    "confirmed",
  );
  return {
    balanceLamports: BigInt(lamports),
    balanceSol: lamports / LAMPORTS_PER_SOL,
  };
}

/**
 * Fetch + decode a Market account by (authority, marketSeed). null if missing.
 * Layout (after the 8-byte account discriminator): authority[32] market_seed:u64
 * question_hash[32] rake_bps:u16 status:u8 outcome:u8 pool_yes:u64 pool_no:u64
 * seed_yes:u64 seed_no:u64 vault_bump:u8 bump:u8.
 */
export async function fetchMarket(
  ctx: ChainContext,
  authority: string,
  marketSeed: bigint | number,
): Promise<MarketAccount | null> {
  const [marketPk] = deriveMarketPda(
    ctx.programId,
    new PublicKey(authority),
    marketSeed,
  );
  const info = await ctx.connection.getAccountInfo(marketPk, "confirmed");
  if (!info) return null;
  const d = Buffer.from(info.data);
  return {
    address: marketPk.toBase58(),
    authority: new PublicKey(d.subarray(8, 40)).toBase58(),
    marketSeed: d.readBigUInt64LE(40),
    questionHashHex: bytesToHex(d.subarray(48, 80)),
    rakeBps: d.readUInt16LE(80),
    status: STATUS[d[82]] ?? "Open",
    outcome: OUTCOME[d[83]] ?? "None",
    poolYesLamports: d.readBigUInt64LE(84),
    poolNoLamports: d.readBigUInt64LE(92),
    seedYesLamports: d.readBigUInt64LE(100),
    seedNoLamports: d.readBigUInt64LE(108),
    vaultBump: d[116],
    bump: d[117],
  };
}

/**
 * Fetch + decode the caller's Bet account on a market. null if no bet placed.
 * Layout (after disc): market[32] bettor[32] side:u8 stake:u64 claimed:u8 bump:u8.
 */
export async function fetchBet(
  ctx: ChainContext,
  authority: string,
  marketSeed: bigint | number,
  bettor?: string,
): Promise<BetAccount | null> {
  const [marketPk] = deriveMarketPda(
    ctx.programId,
    new PublicKey(authority),
    marketSeed,
  );
  const bettorPk = bettor ? new PublicKey(bettor) : ctx.wallet.publicKey;
  const [betPk] = deriveBetPda(ctx.programId, marketPk, bettorPk);
  const info = await ctx.connection.getAccountInfo(betPk, "confirmed");
  if (!info) return null;
  const d = Buffer.from(info.data);
  return {
    address: betPk.toBase58(),
    market: new PublicKey(d.subarray(8, 40)).toBase58(),
    bettor: new PublicKey(d.subarray(40, 72)).toBase58(),
    side: d[72] === 1 ? "No" : "Yes",
    stakeLamports: d.readBigUInt64LE(73),
    claimed: d[81] === 1,
    bump: d[82],
  };
}

// ── preview (no network for the math; mirrors the program exactly) ──────────────

/**
 * Quote the estimated payout for `stake` on `side`, from the live pool.
 * The final claim payout floats with the pool until betting closes.
 */
export function quoteBet(
  market: Pick<MarketAccount, "poolYesLamports" | "poolNoLamports" | "rakeBps">,
  side: OnChainSide,
  stakeLamports: bigint | number,
): BetQuote {
  const stake = BigInt(stakeLamports);
  const estimatedPayout = indicativePayout(
    market.poolYesLamports,
    market.poolNoLamports,
    market.rakeBps,
    side,
    stake,
  );
  const estimatedMult = indicativeMultipleBps(
    market.poolYesLamports,
    market.poolNoLamports,
    market.rakeBps,
    side,
    stake,
  );
  return {
    side,
    stakeLamports: stake,
    estimatedMultBps: estimatedMult,
    estimatedMultiple: bpsToMultiple(estimatedMult),
    estimatedPayoutLamports: estimatedPayout,
  };
}

// ── airdrop (devnet / localnet faucet) ──────────────────────────────────────────

/**
 * Request an airdrop into the embedded wallet (the simplest "deposit" on
 * devnet/localnet). Confirms before resolving. Throws on mainnet.
 */
export async function requestAirdrop(
  ctx: ChainContext,
  sol: number,
): Promise<TxResult> {
  if (!ctx.config.airdropEnabled) {
    throw new Error("Airdrop is only available on devnet / testnet / localnet.");
  }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const signature = await ctx.connection.requestAirdrop(
        ctx.wallet.publicKey,
        lamports,
      );
      const latest = await ctx.connection.getLatestBlockhash("confirmed");
      await ctx.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed",
      );
      return {
        signature,
        explorerUrl: explorerTxUrl(signature, ctx.config.cluster),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Airdrop failed");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Withdraw SOL from the embedded wallet to an external address (cash out). */
export async function withdrawSol(
  ctx: ChainContext,
  toAddress: string,
  sol: number,
): Promise<TxResult> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  const ix = SystemProgram.transfer({
    fromPubkey: ctx.wallet.publicKey,
    toPubkey: new PublicKey(toAddress),
    lamports,
  });
  const tx = new Transaction().add(ix);
  const signature = await ctx.provider.sendAndConfirm(tx, []);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature, ctx.config.cluster),
  };
}

// ── instructions (raw mirrors of the program's #[program] entrypoints) ──────────

/**
 * `place_bet(side, stake)` — the embedded wallet backs `side` and moves the
 * stake into the vault. No fixed payout is stored.
 * Accounts (program order): bettor(s,w), market(w), vault(w), bet(w), system.
 */
export async function placeBet(
  ctx: ChainContext,
  args: PlaceBetArgs,
): Promise<TxResult> {
  const authorityPk = new PublicKey(args.authority);
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, args.marketSeed);
  const [vaultPk] = deriveVaultPda(ctx.programId, marketPk);
  const [betPk] = deriveBetPda(ctx.programId, marketPk, ctx.wallet.publicKey);
  const data = Buffer.concat([
    disc("place_bet"),
    Buffer.from([sideByte(args.side)]),
    u64le(args.stakeLamports),
  ]);
  return send(
    ctx,
    [
      meta(ctx.wallet.publicKey, true, true),
      meta(marketPk, false, true),
      meta(vaultPk, false, true),
      meta(betPk, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  );
}

/**
 * `claim()` — settle the embedded wallet's bet on a Resolved/Void market.
 * Accounts: bettor(s,w), market(ro), vault(w), bet(w), system.
 */
export async function claim(
  ctx: ChainContext,
  args: ClaimArgs,
): Promise<TxResult> {
  const authorityPk = new PublicKey(args.authority);
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, args.marketSeed);
  const [vaultPk] = deriveVaultPda(ctx.programId, marketPk);
  const [betPk] = deriveBetPda(ctx.programId, marketPk, ctx.wallet.publicKey);
  return send(
    ctx,
    [
      meta(ctx.wallet.publicKey, true, true),
      meta(marketPk, false, false),
      meta(vaultPk, false, true),
      meta(betPk, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    disc("claim"),
  );
}

/**
 * `initialize_market(...)` — OPERATOR-ONLY (the embedded wallet is authority).
 * Present for self-hosting a market on devnet / QA. Accounts: authority(s,w),
 * market(w), vault(w), system.
 */
export async function initializeMarket(
  ctx: ChainContext,
  params: {
    marketSeed: bigint | number;
    questionHash: Uint8Array; // exactly 32 bytes
    rakeBps: number;
    seedYesLamports: bigint | number;
    seedNoLamports: bigint | number;
  },
): Promise<TxResult & { pdas: MarketPdas }> {
  if (params.questionHash.length !== 32) {
    throw new Error("questionHash must be exactly 32 bytes.");
  }
  const authorityPk = ctx.wallet.publicKey;
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, params.marketSeed);
  const [vaultPk] = deriveVaultPda(ctx.programId, marketPk);
  const data = Buffer.concat([
    disc("initialize_market"),
    u64le(params.marketSeed),
    Buffer.from(params.questionHash),
    u16le(params.rakeBps),
    u64le(params.seedYesLamports),
    u64le(params.seedNoLamports),
  ]);
  const res = await send(
    ctx,
    [
      meta(authorityPk, true, true),
      meta(marketPk, false, true),
      meta(vaultPk, false, true),
      meta(SystemProgram.programId, false, false),
    ],
    data,
  );
  return {
    ...res,
    pdas: { market: marketPk.toBase58(), vault: vaultPk.toBase58() },
  };
}

/** `resolve_market(outcome)` — OPERATOR-ONLY. Accounts: authority(s,ro), market(w). */
export async function resolveMarket(
  ctx: ChainContext,
  marketSeed: bigint | number,
  outcome: Exclude<OnChainOutcome, "None">,
): Promise<TxResult> {
  const authorityPk = ctx.wallet.publicKey;
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, marketSeed);
  const data = Buffer.concat([
    disc("resolve_market"),
    Buffer.from([outcomeByte(outcome)]),
  ]);
  return send(
    ctx,
    [meta(authorityPk, true, false), meta(marketPk, false, true)],
    data,
  );
}

/** `lock_market()` — OPERATOR-ONLY. Open → Locked. */
export async function lockMarket(
  ctx: ChainContext,
  marketSeed: bigint | number,
): Promise<TxResult> {
  const authorityPk = ctx.wallet.publicKey;
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, marketSeed);
  return send(
    ctx,
    [meta(authorityPk, true, false), meta(marketPk, false, true)],
    disc("lock_market"),
  );
}

/** `void_market()` — OPERATOR-ONLY. Open|Locked → Void (everyone refunds). */
export async function voidMarket(
  ctx: ChainContext,
  marketSeed: bigint | number,
): Promise<TxResult> {
  const authorityPk = ctx.wallet.publicKey;
  const [marketPk] = deriveMarketPda(ctx.programId, authorityPk, marketSeed);
  return send(
    ctx,
    [meta(authorityPk, true, false), meta(marketPk, false, true)],
    disc("void_market"),
  );
}
