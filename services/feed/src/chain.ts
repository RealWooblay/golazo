/**
 * On-chain settlement mirror for the feed service.
 *
 * WHY this exists: the off-chain `MarketEngine` is the source of truth for the
 * live UX (instant odds, bet-delay, broadcasts). This module is the *settlement
 * mirror*: it drives the deployed `golazo-parimutuel` Solana program so the same
 * market lifecycle (open -> lock -> resolve) is recorded on-chain by the
 * operator. It is deliberately fire-and-forget: every method is wrapped so a
 * chain hiccup logs a warning and returns `null` — the feed NEVER crashes
 * because Solana is slow/unreachable.
 *
 * HOW it talks to the program: exactly like
 * `programs/golazo-parimutuel/scripts/onchain-demo.mjs` — no IDL. Instructions
 * are built from the Anchor discriminator `sha256("global:<ix>")[:8]` plus a
 * hand-rolled borsh arg layout, and accounts are passed in the precise order the
 * Rust `#[derive(Accounts)]` structs declare them.
 *
 * The operator's own pubkey is used as the market `authority`, so PDA derivation
 * (`["market", authority, market_seed]`) is stable and the operator can
 * lock/resolve markets it created.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
} from '@solana/web3.js';

/** The deployed `golazo-parimutuel` program id (Anchor `declare_id!`). */
const DEFAULT_PROGRAM_ID = 'GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu';

/** Localnet validator — the default so `CHAIN_ENABLED=1` "just works" locally. */
const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';

/** Confirmed is the demo's level: fast enough yet durable for a settlement mirror. */
const COMMITMENT: Commitment = 'confirmed';

/** System-account rent-exempt minimum (0-byte data). Claims must leave this in the vault. */
const VAULT_RENT_MIN_LAMPORTS = 890_880;

/**
 * Solvency top-up retry budget. We re-read the pool and re-top-up a few times
 * before settling so a real-money `place_bet` that confirmed on the client but
 * is still propagating to our RPC is included in the gross we fund for. Mirrors
 * the client claim loop's patience (6 × 2.5s) with headroom to spare.
 */
const MAX_SOLVENCY_ATTEMPTS = 4;
const SOLVENCY_RETRY_MS = 1500;

/**
 * Lamports the operator must keep above any top-up — headroom for transaction
 * fees so a top-up never drains the operator into a state where it can no longer
 * lock/resolve. ~0.01 SOL ≈ 2000 signatures at 5000 lamports each.
 */
const OPERATOR_FEE_RESERVE_LAMPORTS = 10_000_000n;

/**
 * Below this, a market side has NO genuine opponent — only the house seed. A real-money
 * YES/NO market that is one-sided (real stake = pool − seed ≤ this on EITHER side) is
 * VOIDED (refund all) instead of resolved, so a lone bettor never wins ~nothing (own
 * stake back, seed-diluted) nor loses everything to the house seed. 50k lamports
 * (0.00005 SOL) sits far below any real stake but above rounding noise.
 * MAINNET: pair with a program-side min-stake (none exists today) so a dust-above bet
 * can't masquerade as a real opponent to force a resolve — see the mainnet checklist.
 */
const ONE_SIDED_DUST_LAMPORTS = 50_000n;

/** MarketStatus discriminant for `Locked` (state.rs enum order: Open=0, Locked=1, …). */
const MARKET_STATUS_LOCKED = 1;

/** PDA seed prefixes — mirror `instructions::seeds` in the program. */
const SEED_MARKET = Buffer.from('market');
const SEED_VAULT = Buffer.from('vault');

/**
 * On-chain `Outcome` enum (state.rs): `None=0, Yes=1, No=2`.
 * `resolve_market` only accepts `Yes`/`No`; VOID is a separate instruction.
 */
const OUTCOME = { YES: 1, NO: 2 } as const;

/** The two PDAs every market lifecycle call needs. */
export interface MarketPdas {
  marketPda: PublicKey;
  vaultPda: PublicKey;
}

/** Result of `initMarket` — the derived PDAs plus the confirmed tx signature. */
export interface InitMarketResult extends MarketPdas {
  signature: string;
}

/** Result of `lockMarket` / `resolveMarket`. */
export interface TxResult extends MarketPdas {
  signature: string;
}

/** Args for {@link FeedChainOperator.initMarket}. */
export interface InitMarketArgs {
  /** Stable per-market u64 discriminator; part of the market PDA seeds. */
  marketSeed: number | bigint;
  /** Human question ("Argentina — GOAL?"); hashed to the on-chain `question_hash`. */
  questionText: string;
  /** Operator rake in basis points (e.g. 600 == 6%). Must be < 10_000. */
  rakeBps: number;
  /** House YES seed in lamports. Must be > 0. */
  seedYesLamports: number | bigint;
  /** House NO seed in lamports. Must be > 0. */
  seedNoLamports: number | bigint;
}

/** Env-derived construction options (each falls back to a sensible default). */
export interface FeedChainOptions {
  /** Master switch. When false, the operator is a no-op. */
  enabled?: boolean;
  /** base58 secret key OR a path to a JSON keypair file (solana CLI format). */
  operatorKeypair?: string | undefined;
  /** Solana RPC endpoint. Defaults to localnet. */
  rpcUrl?: string;
  /** Program id. Defaults to the deployed id. */
  programId?: string;
}

// --- borsh / discriminator helpers (mirror onchain-demo.mjs) ----------------

/** Anchor instruction discriminator: first 8 bytes of sha256("global:<name>"). */
function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Little-endian u64 (accepts number or bigint). */
function u64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** Little-endian u16. */
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/** Single byte (enum tag / u8). */
function u8(n: number): Buffer {
  return Buffer.from([n]);
}

/** sha256 of the question text → the 32-byte on-chain `question_hash`. */
function questionHash(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

// --- keypair loading --------------------------------------------------------

/** Bitcoin/Solana base58 alphabet. */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode a base58 string to bytes — a small, dependency-free implementation so
 * the module needs nothing beyond `@solana/web3.js`. Throws on any non-base58
 * character so a malformed `OPERATOR_KEYPAIR` is caught at construction.
 */
function decodeBase58(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const ch of s) {
    const value = BASE58_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58 character: ${ch}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading '1' is a leading zero byte.
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}

/**
 * Load the operator keypair from either:
 *   - a path to a JSON keypair file (the `solana-keygen` / `~/.config/solana/id.json`
 *     format: a JSON array of 64 bytes), or
 *   - a base58-encoded secret key string.
 *
 * Throws on a malformed value so construction can decide to fall back to no-op.
 */
function loadKeypair(value: string): Keypair {
  const trimmed = value.trim();

  // A path to a JSON keypair file. Detect by extension OR by it looking like a
  // filesystem path; fall through to base58 on any read/parse failure.
  const looksLikePath =
    trimmed.endsWith('.json') || trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.startsWith('.');
  if (looksLikePath) {
    const path = trimmed.startsWith('~')
      ? trimmed.replace(/^~/, process.env.HOME ?? '')
      : trimmed;
    const raw = readFileSync(path, 'utf8');
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  // Otherwise treat it as a base58 secret key.
  return Keypair.fromSecretKey(decodeBase58(trimmed));
}

/**
 * Read {@link FeedChainOptions} from the environment.
 *
 *   CHAIN_ENABLED     — "1"/"true"/"yes"/"on" enables the operator.
 *   OPERATOR_KEYPAIR  — base58 secret key OR path to a JSON keypair file.
 *   SOLANA_RPC_URL    — defaults to localnet (http://127.0.0.1:8899).
 *   GOLAZO_PROGRAM_ID — defaults to the deployed id.
 */
export function chainOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FeedChainOptions {
  const flag = env.CHAIN_ENABLED?.trim().toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  return {
    enabled,
    operatorKeypair: env.OPERATOR_KEYPAIR?.trim() || undefined,
    rpcUrl: env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL,
    programId: env.GOLAZO_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID,
  };
}

/**
 * The feed's on-chain operator. When enabled with a valid keypair it mirrors the
 * market lifecycle to the deployed program; otherwise every method is a no-op
 * that returns `null`.
 */
export class FeedChainOperator {
  /** True only when enabled AND a keypair loaded successfully. */
  readonly active: boolean;
  readonly programId: PublicKey | null;
  readonly rpcUrl: string;

  private readonly connection: Connection | null;
  private readonly operator: Keypair | null;

  constructor(opts: FeedChainOptions = {}) {
    const rpcUrl = opts.rpcUrl?.trim() || DEFAULT_RPC_URL;
    this.rpcUrl = rpcUrl;

    // Disabled, or no keypair → permanent no-op. Never throws.
    if (!opts.enabled || !opts.operatorKeypair) {
      this.active = false;
      this.programId = null;
      this.connection = null;
      this.operator = null;
      return;
    }

    // Enabled: try to wire up. Any failure (bad keypair, bad program id) demotes
    // to no-op with a warning rather than crashing the feed.
    let operator: Keypair | null = null;
    let programId: PublicKey | null = null;
    let connection: Connection | null = null;
    try {
      operator = loadKeypair(opts.operatorKeypair);
      programId = new PublicKey(opts.programId?.trim() || DEFAULT_PROGRAM_ID);
      connection = new Connection(rpcUrl, COMMITMENT);
    } catch (err) {
      this.warn('init', err);
      operator = null;
      programId = null;
      connection = null;
    }

    this.operator = operator;
    this.programId = programId;
    this.connection = connection;
    this.active = operator !== null && programId !== null && connection !== null;
  }

  /** The operator's public key (used as the market authority), or null when inactive. */
  get operatorPubkey(): PublicKey | null {
    return this.operator?.publicKey ?? null;
  }

  /**
   * Derive the `market` and `vault` PDAs for a seed using the operator as
   * authority. Returns `null` when inactive (no operator/program to derive from).
   */
  derivePdas(marketSeed: number | bigint): MarketPdas | null {
    if (!this.active || !this.operator || !this.programId) return null;
    return this.derive(marketSeed, this.operator.publicKey, this.programId);
  }

  /**
   * Create a market on-chain (operator = authority), folding the house seed into
   * both pools. Mirrors `initialize_market`:
   *   accounts: [authority(signer,mut), market(mut), vault(mut), system_program]
   *   args:     market_seed u64, question_hash [u8;32], rake_bps u16,
   *             seed_yes u64, seed_no u64
   */
  async initMarket(args: InitMarketArgs): Promise<InitMarketResult | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return null;

    try {
      const authority = this.operator.publicKey;
      const { marketPda, vaultPda } = this.derive(args.marketSeed, authority, this.programId);

      const data = Buffer.concat([
        disc('initialize_market'),
        u64(args.marketSeed),
        questionHash(args.questionText),
        u16(args.rakeBps),
        u64(args.seedYesLamports),
        u64(args.seedNoLamports),
      ]);

      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority, isSigner: true, isWritable: true },
          { pubkey: marketPda, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const signature = await this.send(ix);
      return { marketPda, vaultPda, signature };
    } catch (err) {
      this.warn('initMarket', err);
      return null;
    }
  }

  /**
   * Lock a market (Open -> Locked). Mirrors `lock_market`:
   *   accounts: [authority(signer), market(mut)]   args: none
   */
  async lockMarket(marketSeed: number | bigint): Promise<TxResult | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return null;

    try {
      const authority = this.operator.publicKey;
      const { marketPda, vaultPda } = this.derive(marketSeed, authority, this.programId);

      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: true },
        ],
        data: disc('lock_market'),
      });

      const signature = await this.send(ix);
      return { marketPda, vaultPda, signature };
    } catch (err) {
      this.warn('lockMarket', err);
      return null;
    }
  }

  /**
   * Resolve a market to a real outcome (Open|Locked -> Resolved). Mirrors
   * `resolve_market`:
   *   accounts: [authority(signer), market(mut)]   args: outcome u8 (Yes=1, No=2)
   */
  async resolveMarket(
    marketSeed: number | bigint,
    outcome: 'YES' | 'NO',
  ): Promise<TxResult | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return null;

    try {
      const authority = this.operator.publicKey;
      const { marketPda, vaultPda } = this.derive(marketSeed, authority, this.programId);

      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([disc('resolve_market'), u8(OUTCOME[outcome])]),
      });

      const signature = await this.send(ix);
      return { marketPda, vaultPda, signature };
    } catch (err) {
      this.warn('resolveMarket', err);
      return null;
    }
  }

  /**
   * Void a market (Open|Locked -> Void). Mirrors `void_market` — everyone refunds.
   * Used when the play resolves before the betting window closes (timing fault).
   */
  async voidMarket(marketSeed: number | bigint): Promise<TxResult | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return null;

    try {
      const authority = this.operator.publicKey;
      const { marketPda, vaultPda } = this.derive(marketSeed, authority, this.programId);

      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority, isSigner: true, isWritable: false },
          { pubkey: marketPda, isSigner: false, isWritable: true },
        ],
        data: disc('void_market'),
      });

      const signature = await this.send(ix);
      return { marketPda, vaultPda, signature };
    } catch (err) {
      this.warn('voidMarket', err);
      return null;
    }
  }

  /**
   * Settle on-chain: YES/NO via resolve_market, VOID via void_market.
   *
   * CRITICAL ordering: we make the vault solvent FIRST and only resolve if it
   * succeeded. Resolving an insolvent vault would brick every winner's claim
   * (InsufficientVaultFunds) with no way back, so if the top-up can't cover the
   * pool we leave the market Open/Locked and bail — a later settle (or operator
   * intervention) can retry. The off-chain market is the source of truth for the
   * UX either way, so an unresolved on-chain mirror is the safe failure mode.
   */
  async settleMarket(
    marketSeed: number | bigint,
    outcome: 'YES' | 'NO' | 'VOID',
  ): Promise<TxResult | null> {
    const solvent = await this.ensureVaultSolvency(marketSeed);
    if (!solvent) {
      this.warn(
        'settleMarket',
        new Error(
          `vault still short for seed=${marketSeed}; NOT resolving (claims would brick) — left Open/Locked for retry`,
        ),
      );
      return null;
    }
    if (outcome === 'VOID') return this.voidMarket(marketSeed);

    // NO-COUNTERPARTY GUARD: a real-money YES/NO market with no genuine opponent on a
    // side must REFUND, not resolve — otherwise the lone bettor either wins ~nothing
    // (own stake back, diluted by the house seed) or, if they backed the losing side,
    // loses everything to the seed. We lock first (awaited, so the pool is provably
    // frozen — unlike the orchestrator's fire-and-forget lock) and only void when we
    // can CONFIRM one-sidedness on a Locked market; any uncertainty resolves as before.
    if (await this.isOneSidedRealBook(marketSeed)) {
      return this.voidMarket(marketSeed);
    }
    return this.resolveMarket(marketSeed, outcome);
  }

  /**
   * True when a real-money market lacks a genuine two-sided book — at least one side
   * holds only the house seed (real stake = pool − seed ≤ dust). Such a market must be
   * VOIDED (refund) rather than resolved. Locks the market first (idempotent, AWAITED)
   * so no late bet can change the pool between this read and settlement — this is what
   * closes the bet/settle race. Returns false (→ resolve as before, NO regression and no
   * stranding) whenever we cannot PROVE one-sidedness: an unreadable pool, or a market
   * not confirmed Locked. So we only ever refund when certain.
   */
  private async isOneSidedRealBook(marketSeed: number | bigint): Promise<boolean> {
    // Read first: the orchestrator's flushChainLock usually already Locked the market,
    // so we avoid a redundant (and log-noisy) lock attempt. Only if it's still Open do
    // we lock — AWAITED, so the pool is provably frozen — and re-read.
    let pools = await this.readMarketPools(marketSeed);
    if (pools && pools.status !== MARKET_STATUS_LOCKED) {
      await this.lockMarket(marketSeed);
      pools = await this.readMarketPools(marketSeed);
    }
    if (!pools || pools.status !== MARKET_STATUS_LOCKED) return false; // not provably frozen
    const realYes = pools.poolYes > pools.seedYes ? pools.poolYes - pools.seedYes : 0n;
    const realNo = pools.poolNo > pools.seedNo ? pools.poolNo - pools.seedNo : 0n;
    const oneSided = realYes <= ONE_SIDED_DUST_LAMPORTS || realNo <= ONE_SIDED_DUST_LAMPORTS;
    if (oneSided) {
      console.log(
        `[chain] one-sided market seed=${marketSeed} realYes=${realYes} realNo=${realNo} ` +
          `<= dust ${ONE_SIDED_DUST_LAMPORTS} — VOIDing (refund all, no genuine opponent)`,
      );
    }
    return oneSided;
  }

  /**
   * Read pools + seed + lifecycle status from the on-chain Market account. Offsets are
   * fixed by state.rs field order after the 8-byte Anchor discriminator: status@82,
   * pool_yes@84, pool_no@92, seed_yes@100, seed_no@108 (Market::SIZE = 118). Returns null
   * on a short/absent account or transient RPC error (caller treats null as "unknown").
   */
  private async readMarketPools(marketSeed: number | bigint): Promise<{
    poolYes: bigint;
    poolNo: bigint;
    seedYes: bigint;
    seedNo: bigint;
    status: number;
  } | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return null;
    try {
      const { marketPda } = this.derive(marketSeed, this.operator.publicKey, this.programId);
      const info = await this.connection.getAccountInfo(marketPda, COMMITMENT);
      if (!info?.data || info.data.length < 118) return null; // < Market::SIZE → not a market
      const d = info.data;
      return {
        status: d.readUInt8(82),
        poolYes: d.readBigUInt64LE(84),
        poolNo: d.readBigUInt64LE(92),
        seedYes: d.readBigUInt64LE(100),
        seedNo: d.readBigUInt64LE(108),
      };
    } catch (err) {
      this.warn('readMarketPools', err);
      return null;
    }
  }

  /**
   * Ensure the market vault can cover the FULL gross pool plus the rent-exempt
   * minimum, topping up from the operator if short. Returns `true` once the vault
   * is provably solvent, `false` if it could not be made so (operator too poor,
   * transfers kept failing, or RPC unreadable) — in which case the caller MUST
   * NOT resolve.
   *
   * Hardening vs. the naive single-read top-up:
   *   - retries (re-reading the pool each pass) to catch a still-propagating
   *     real-money bet that the first read missed — closes the bet/resolve race;
   *   - never swallows a failed transfer into apparent success — a failure just
   *     means the loop tries again and, if it never recovers, we return `false`;
   *   - guards on operator balance so a top-up never drains the fee reserve;
   *   - no fixed deficit cap — the operator-balance guard is the natural bound,
   *     and a corrupt over-large read simply exceeds it and returns `false`.
   *
   * No-op (`true`) when the operator is inactive or there is no on-chain market
   * to keep solvent — there is nothing that could brick a claim.
   */
  async ensureVaultSolvency(marketSeed: number | bigint): Promise<boolean> {
    if (!this.active || !this.operator || !this.programId || !this.connection) return true;

    const authority = this.operator.publicKey;
    const { marketPda, vaultPda } = this.derive(marketSeed, authority, this.programId);

    for (let attempt = 0; attempt < MAX_SOLVENCY_ATTEMPTS; attempt++) {
      const status = await this.readVaultStatus(marketPda, vaultPda);
      if (status === 'no-market') return true; // nothing on-chain → nothing to brick
      if (status === null) {
        await this.sleep(SOLVENCY_RETRY_MS * (attempt + 1));
        continue; // transient RPC error — retry
      }

      const { needed, vaultBal } = status;
      if (vaultBal >= needed) return true; // solvent

      const deficit = needed - vaultBal;

      // Operator-balance guard: never attempt a transfer we can't cover while
      // leaving a fee reserve. If the operator is too poor, the vault cannot be
      // made solvent — fail so the caller does NOT resolve.
      let opBal: bigint;
      try {
        opBal = BigInt(await this.connection.getBalance(authority, COMMITMENT));
      } catch (err) {
        this.warn('ensureVaultSolvency.opbal', err);
        await this.sleep(SOLVENCY_RETRY_MS * (attempt + 1));
        continue;
      }
      if (opBal < deficit + OPERATOR_FEE_RESERVE_LAMPORTS) {
        this.warn(
          'ensureVaultSolvency',
          new Error(
            `operator ${authority.toBase58().slice(0, 6)}… balance ${opBal} < deficit ${deficit} ` +
              `+ reserve ${OPERATOR_FEE_RESERVE_LAMPORTS}; cannot fund vault seed=${marketSeed}`,
          ),
        );
        return false;
      }

      try {
        const sig = await this.send(
          SystemProgram.transfer({
            fromPubkey: authority,
            toPubkey: vaultPda,
            lamports: deficit,
          }),
          'vaultTopUp',
        );
        console.log(`[chain] vault top-up seed=${marketSeed} +${deficit} lamports sig=${sig}`);
      } catch (err) {
        // Do NOT swallow into success — log and let the loop re-read/retry. If we
        // exhaust attempts the final verification below decides solvency.
        this.warn('ensureVaultSolvency.transfer', err);
      }

      // Re-read on the next pass to confirm the top-up landed AND fold in any
      // bet that propagated in the meantime.
      await this.sleep(SOLVENCY_RETRY_MS);
    }

    // Attempts exhausted — verify one last time so we only return `true` when the
    // vault genuinely covers the pool.
    const finalStatus = await this.readVaultStatus(marketPda, vaultPda);
    if (finalStatus === 'no-market') return true;
    if (finalStatus === null) return false;
    return finalStatus.vaultBal >= finalStatus.needed;
  }

  /**
   * Read the vault's lamport balance and the lamports it must hold to be solvent
   * (gross pool + rent-exempt minimum). Returns `'no-market'` when there is no
   * on-chain market account, or `null` on a transient RPC error (caller retries).
   */
  private async readVaultStatus(
    marketPda: PublicKey,
    vaultPda: PublicKey,
  ): Promise<{ needed: bigint; vaultBal: bigint } | 'no-market' | null> {
    if (!this.connection) return null;
    try {
      const [marketInfo, vaultBal] = await Promise.all([
        this.connection.getAccountInfo(marketPda, COMMITMENT),
        this.connection.getBalance(vaultPda, COMMITMENT),
      ]);
      if (!marketInfo?.data || marketInfo.data.length < 100) return 'no-market';
      const d = marketInfo.data;
      const gross = d.readBigUInt64LE(84) + d.readBigUInt64LE(92);
      return { needed: gross + BigInt(VAULT_RENT_MIN_LAMPORTS), vaultBal: BigInt(vaultBal) };
    } catch (err) {
      this.warn('ensureVaultSolvency.read', err);
      return null;
    }
  }

  /** Small awaitable delay used by the solvency retry loop. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- internals ------------------------------------------------------------

  /** Pure PDA derivation; no `this` state so it's safe to call before `active`. */
  private derive(marketSeed: number | bigint, authority: PublicKey, programId: PublicKey): MarketPdas {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [SEED_MARKET, authority.toBuffer(), u64(marketSeed)],
      programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [SEED_VAULT, marketPda.toBuffer()],
      programId,
    );
    return { marketPda, vaultPda };
  }

  /** Build, sign (operator) and confirm a single-instruction transaction. */
  private async send(ix: TransactionInstruction, op = 'tx'): Promise<string> {
    if (!this.connection || !this.operator) throw new Error('chain operator inactive');
    const tx = new Transaction().add(ix);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await sendAndConfirmTransaction(this.connection, tx, [this.operator], {
          commitment: COMMITMENT,
        });
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          console.warn(`[chain] ${op} retry ${attempt + 2}/3`);
        }
      }
    }
    throw lastErr;
  }

  /** Consistent, non-fatal warning. The off-chain market remains source of truth. */
  private warn(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[chain] ${op} failed (off-chain market unaffected): ${msg}`);
  }
}

/** Build a {@link FeedChainOperator} from the process environment. */
export function createChainOperator(env: NodeJS.ProcessEnv = process.env): FeedChainOperator {
  return new FeedChainOperator(chainOptionsFromEnv(env));
}
