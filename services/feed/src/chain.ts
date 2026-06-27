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
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
} from '@solana/web3.js';

/** The deployed `golazo-parimutuel` program id (Anchor `declare_id!`). */
const DEFAULT_PROGRAM_ID = '3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM';

/** Localnet validator — the default so `CHAIN_ENABLED=1` "just works" locally. */
const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';

/** Confirmed is the demo's level: fast enough yet durable for a settlement mirror. */
const COMMITMENT: Commitment = 'confirmed';

/**
 * The protocol settles in USX (SPL classic), not SOL. The vault is a PDA-owned
 * USX token account whose balance IS the pool exactly (token rent is separate
 * SOL), so — unlike the old native-SOL design — there is no rent reservation to
 * top up and the vault is solvent by construction. The operator only needs SOL
 * to pay tx fees and a USX account to fund any (optional) house seed.
 */
const DEFAULT_USX_MINT = '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Below this, a market side has NO genuine opponent — only the house seed. A real-money
 * YES/NO market that is one-sided (real stake = pool − seed ≤ this on EITHER side) is
 * VOIDED (refund all) instead of resolved, so a lone bettor never wins ~nothing (own
 * stake back, seed-diluted) nor loses everything to the house seed. 50k USX base units
 * ($0.05) sits far below any real stake but above rounding noise.
 * MAINNET: pair with a program-side min-stake (none exists today) so a dust-above bet
 * can't masquerade as a real opponent to force a resolve — see the mainnet checklist.
 */
const ONE_SIDED_DUST_BASE_UNITS = 50_000n;

/**
 * Operator SOL floor. Below this we STOP opening NEW on-chain markets (existing
 * locks/resolves still run — those are cheap + critical). Rationale: if the
 * operator runs dry mid-match it can't lock/resolve, and any USX staked in an
 * unresolvable market is TRAPPED until it's refunded. Refusing to open new
 * markets when gas is low caps that blast radius to markets already in flight.
 * ~0.05 SOL covers many lock+settle tx fees; top up well before this.
 */
const MIN_OPERATOR_LAMPORTS = 50_000_000;
/** Re-check the operator balance at most this often (avoid an RPC per market). */
const GAS_CHECK_THROTTLE_MS = 30_000;

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
  /** House YES seed in USX base units (0 in zero-capital mode — the default). */
  seedYesLamports: number | bigint;
  /** House NO seed in USX base units (0 in zero-capital mode — the default). */
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
  /** USX mint the program settles in. Defaults to the deployed USX mint. */
  usxMint?: string;
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
    usxMint: env.USX_MINT?.trim() || DEFAULT_USX_MINT,
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
  private readonly usxMint: PublicKey | null;

  /** Throttled operator-SOL gate: don't open NEW markets when gas is low. */
  private gasOk = true;
  private lastGasCheckMs = 0;

  constructor(opts: FeedChainOptions = {}) {
    const rpcUrl = opts.rpcUrl?.trim() || DEFAULT_RPC_URL;
    this.rpcUrl = rpcUrl;

    // Disabled, or no keypair → permanent no-op. Never throws.
    if (!opts.enabled || !opts.operatorKeypair) {
      this.active = false;
      this.programId = null;
      this.connection = null;
      this.operator = null;
      this.usxMint = null;
      return;
    }

    // Enabled: try to wire up. Any failure (bad keypair, bad program id) demotes
    // to no-op with a warning rather than crashing the feed.
    let operator: Keypair | null = null;
    let programId: PublicKey | null = null;
    let connection: Connection | null = null;
    let usxMint: PublicKey | null = null;
    try {
      operator = loadKeypair(opts.operatorKeypair);
      programId = new PublicKey(opts.programId?.trim() || DEFAULT_PROGRAM_ID);
      usxMint = new PublicKey(opts.usxMint?.trim() || DEFAULT_USX_MINT);
      connection = new Connection(rpcUrl, COMMITMENT);
    } catch (err) {
      this.warn('init', err);
      operator = null;
      programId = null;
      connection = null;
      usxMint = null;
    }

    this.operator = operator;
    this.programId = programId;
    this.connection = connection;
    this.usxMint = usxMint;
    this.active =
      operator !== null && programId !== null && connection !== null && usxMint !== null;
  }

  /** Associated token account for (owner, USX mint). */
  private ata(owner: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM,
    )[0];
  }

  /** Idempotent "create ATA" instruction (no-op if it already exists). */
  private createAtaIdempotentIx(
    payer: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.ata(owner, mint), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // 1 = CreateIdempotent
    });
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
   * True if the operator holds enough SOL to safely OPEN + later resolve a new
   * market. Throttled to one RPC per {@link GAS_CHECK_THROTTLE_MS}. Only NEW-market
   * creation is gated on this — lock/settle of EXISTING markets are never gated
   * (they must run to free already-staked USX, even on a near-empty operator).
   */
  private async hasGasForNewMarket(): Promise<boolean> {
    if (!this.connection || !this.operator) return false;
    const now = Date.now();
    if (now - this.lastGasCheckMs < GAS_CHECK_THROTTLE_MS) return this.gasOk;
    this.lastGasCheckMs = now;
    try {
      const lamports = await this.connection.getBalance(this.operator.publicKey, COMMITMENT);
      const ok = lamports >= MIN_OPERATOR_LAMPORTS;
      if (ok !== this.gasOk) {
        console.log(
          `[golazo/feed] operator_gas ${ok ? 'ok' : 'LOW'} balance=${(lamports / 1e9).toFixed(4)}SOL` +
            (ok ? ' — resuming on-chain markets' : ' — NOT opening new on-chain markets; TOP UP operator SOL'),
        );
      }
      this.gasOk = ok;
    } catch {
      // Transient RPC read failure — keep the last known state rather than flip the gate.
    }
    return this.gasOk;
  }

  /**
   * Create a USX market on-chain (operator = authority), folding any house seed
   * into both pools. Mirrors `initialize_market`:
   *   accounts: [authority(s,mut), market(mut), usx_mint, vault(mut),
   *              authority_token(mut), token_program, system_program, rent]
   *   args:     market_seed u64, question_hash [u8;32], rake_bps u16,
   *             seed_yes u64, seed_no u64  (seeds in USX base units)
   * A CreateIdempotent ATA ix is prepended so the operator's USX account (the
   * seed source / `authority_token`) always exists, even with a zero seed.
   */
  async initMarket(args: InitMarketArgs): Promise<InitMarketResult | null> {
    if (!this.active || !this.operator || !this.programId || !this.connection || !this.usxMint) {
      return null;
    }
    // OPERATOR-GAS GUARD: never open a market we might not be able to lock/resolve.
    // A market opened with no twin stays points-only; staked USX is never trapped.
    if (!(await this.hasGasForNewMarket())) return null;

    try {
      const authority = this.operator.publicKey;
      const mint = this.usxMint;
      const { marketPda, vaultPda } = this.derive(args.marketSeed, authority, this.programId);
      const authorityToken = this.ata(authority, mint);

      const data = Buffer.concat([
        disc('initialize_market'),
        u64(args.marketSeed),
        questionHash(args.questionText),
        u16(args.rakeBps),
        u64(args.seedYesLamports),
        u64(args.seedNoLamports),
      ]);

      const initIx = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority, isSigner: true, isWritable: true },
          { pubkey: marketPda, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: authorityToken, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data,
      });

      const signature = await this.send(
        [this.createAtaIdempotentIx(authority, authority, mint), initIx],
        'initMarket',
      );
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
   * No solvency step is needed in the USX model: every stake (and any house seed)
   * is held in the vault token account as it arrives, so `vault.amount` always
   * equals the pool and covers every winner's net payout. We only guard against a
   * one-sided book (refund instead of resolve) below.
   */
  async settleMarket(
    marketSeed: number | bigint,
    outcome: 'YES' | 'NO' | 'VOID',
  ): Promise<TxResult | null> {
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
    const oneSided =
      realYes <= ONE_SIDED_DUST_BASE_UNITS || realNo <= ONE_SIDED_DUST_BASE_UNITS;
    if (oneSided) {
      console.log(
        `[chain] one-sided market seed=${marketSeed} realYes=${realYes} realNo=${realNo} ` +
          `<= dust ${ONE_SIDED_DUST_BASE_UNITS} — VOIDing (refund all, no genuine opponent)`,
      );
    }
    return oneSided;
  }

  /**
   * Read pools + seed + lifecycle status from the on-chain Market account. Offsets are
   * fixed by state.rs field order after the 8-byte Anchor discriminator: status@82,
   * pool_yes@84, pool_no@92, seed_yes@100, seed_no@108 (Market::SIZE = 119). Returns null
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
      if (!info?.data || info.data.length < 119) return null; // < Market::SIZE → not a market
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

  /** Build, sign (operator) and confirm a one-or-more-instruction transaction. */
  private async send(
    ix: TransactionInstruction | TransactionInstruction[],
    op = 'tx',
  ): Promise<string> {
    if (!this.connection || !this.operator) throw new Error('chain operator inactive');
    const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
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
