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
  private async send(ix: TransactionInstruction): Promise<string> {
    // Guarded by callers, but assert for the type-narrower.
    if (!this.connection || !this.operator) throw new Error('chain operator inactive');
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [this.operator], {
      commitment: COMMITMENT,
    });
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
