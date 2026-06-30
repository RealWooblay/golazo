/**
 * Centralised, env-driven configuration.
 *
 * WHY a single module: every other file imports `config` from here, so there is
 * exactly one place that reads `process.env` and one place that documents the
 * knobs. Defaults are chosen so that `npm run dev` works with ZERO config —
 * sim feed + rule-based watcher + bots, no API key, no network. That's the
 * "it just runs" guarantee the reviewer relies on.
 */

import { WS_DEFAULT_PORT } from '@golazo/core';
import { FeedChainOperator } from './chain';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How the feed source is selected (see src/feed/index.ts). */
export type FeedMode = 'auto' | 'sim' | 'espn' | 'replay';

export interface Config {
  /** WebSocket + HTTP port. Defaults to the protocol's shared default (8787). */
  port: number;

  /**
   * Anthropic API key for the AI watcher. When absent, the watcher silently
   * falls back to the deterministic rule-based watcher from @golazo/core, so
   * the service is fully functional without it.
   */
  anthropicApiKey: string | undefined;

  /** Model id for the AI watcher — a FAST model so opening a market is low-latency. */
  aiModel: string;

  /** Hard cap on how long we'll wait for the AI before falling back to rules (ms). */
  aiTimeoutMs: number;
  /** Separate (longer) cap for goal settlement AI — worth the extra latency. */
  aiResolveTimeoutMs: number;

  /** How often the director's slow background proposal generator runs (ms). Far slower than a tick. */
  aiRefreshMs: number;
  /** Output-token ceiling per match for the director; exhaustion fails open to templates. */
  aiMatchTokenBudget: number;

  /**
   * MARKET DIRECTOR (off-hot-path AI that proposes WHICH validated markets to open, based
   * on game mood + clock). OFF by default — it can ONLY pick kinds/teams/windows/wording
   * from a validated palette it can never break; off/slow/invalid → the rule openers run
   * (fail-open). Like the enhancer it stays dark until the leaked key is rotated and
   * AI_DIRECTOR=1 is set. It never touches resolution, the chain, or the hot path.
   */
  aiDirectorEnabled: boolean;

  /**
   * Confidence gate (0..1): a judged (free-kick / open-play) market only opens when
   * the AI's confidence it's a REAL, dangerous, timely chance is at least this.
   * Higher = fewer but higher-quality markets. Default 0.6.
   */
  minConfidence: number;

  /**
   * Feed selection:
   *   - 'sim'  : always use the deterministic simulator (great for demos/tests).
   *   - 'espn' : require the real ESPN feed; if none is live, fall back to sim.
   *   - 'auto' : try ESPN, fall back to sim on any failure / no live game.
   */
  feedMode: FeedMode;

  /** ESPN soccer league slug, e.g. 'fifa.world' (World Cup) or 'eng.1'. */
  espnLeague: string;

  /**
   * ESPN summary language for commentary. `dual` fetches EN keyEvents + ES commentary
   * (Spanish is richer on build-up for FIFA). `en` / `es` use a single feed.
   */
  espnCommentaryLang: 'en' | 'es' | 'dual';

  /** For FEED_MODE=replay: the ESPN event id of the real match to replay. */
  replayEventId: string;

  /** Manual override: pin the live feed to this ESPN event id (ignore auto-pick + never
   *  auto-rotate). Empty = normal auto-select of the first live match. */
  forceEventId: string | undefined;

  /** How often to poll the ESPN summary endpoint while a game is live (ms). */
  espnPollMs: number;

  /**
   * Disk path for PLAY-MONEY points persistence. Balances + the leaderboard are loaded
   * from here on boot and snapshotted on settle, so a restart/redeploy never resets a
   * player's points. Defaults to `~/.golazo/points.json` (outside the deploy bundle so a
   * tarball redeploy can't wipe it); set POINTS_STORE_PATH to a persistent volume to be
   * sure. Set empty to disable (pure in-memory).
   */
  pointsStorePath: string | undefined;

  /**
   * Disk path for the compact referral snapshot. Every mutation is also appended to
   * `${REFERRAL_STORE_PATH}.journal`, so a crash does not depend on one rewritten JSON file.
   * Defaults outside the deploy bundle so a redeploy does not wipe partner balances.
   * Set empty to disable disk persistence for local tests only.
   */
  referralStorePath: string | undefined;

  /** Partner share of referred volume, in basis points. 100 = 1 percentage point. */
  referralPayoutBps: number;

  /** Optional bearer token for referral admin writes (create code / mark paid). */
  referralAdminToken: string | undefined;

  /** Operator rake (house edge) handed to the MarketEngine. Default 6%. This IS the trade fee. */
  rake: number;

  /** Treasury wallet that collects the rake/fees (the house's revenue). */
  feeRecipient: string;

  /** Deterministic seed base for the engine / sim, so runs are reproducible. */
  baseSeed: number;

  /**
   * MASTER SWITCH for the liquidity-simulation bots (both the engine swarm and the
   * points swarm). DEFAULT OFF. On-chain liquidity is real users, so the points/real
   * parimutuel multiple must move only on real, aggregated user money. Enable
   * (`LIQUIDITY_BOTS=1`) only as a local liveliness / load-testing aid. When off, the
   * bot counts below are ignored and no synthetic money ever enters any pool.
   */
  liquidityBotsEnabled: boolean;

  /** How many simulated bots trickle bets into each market (real-money engine pool).
   *  Only used when `liquidityBotsEnabled`. */
  botCount: number;

  /** House-liquidity bots for the POINTS pool. Only used when `liquidityBotsEnabled`. */
  pointsBotCount: number;
  pointsBotMinStake: number;
  pointsBotMaxStake: number;

  /**
   * If a market locks but no resolving goal/miss event arrives within this
   * window after lock, the orchestrator VOIDs it (refunds everyone). Real
   * money + doubt = never guess.
   */
  resolveTimeoutMs: number;

  /**
   * Optional anti-latency hold (ms) before a real-money bet enters the pool.
   * Default 0 — tap lands immediately. Set BET_DELAY_MS only if you run a
   * materially slower feed than some bettors' TV/stream and want to void bets
   * that arrive inside the hold when the play resolves first.
   */
  betDelayMs: number;

  /** Paper-mode hold — same 5s anti-snipe as real bets unless POINTS_BET_DELAY_MS overrides. */
  pointsBetDelayMs: number;

  /** Ms before lockAt when the server stops accepting new bets (ESPN lag cushion). */
  betSafetyBufferMs: number;

  /**
   * CHAIN MODE master switch. When on, every off-chain market gets a REAL
   * on-chain twin (init/lock/resolve) driven by the operator keypair. Off-chain
   * remains the source of truth; the chain twin is a best-effort settlement mirror.
   */
  chainEnabled: boolean;

  /** base58 secret key OR path to a JSON keypair file for the on-chain operator. */
  operatorKeypair: string | undefined;

  /** Solana RPC endpoint the operator talks to. Defaults to localnet. */
  solanaRpcUrl: string;

  /** Deployed golazo-parimutuel program id the operator drives. */
  golazoProgramId: string;

  /** Optional operator seed per side. Default 0 for zero-capital pure parimutuel mode. */
  chainSeedLamports: number;

  /**
   * Grace (ms) the ON-CHAIN market lock is deferred PAST the off-chain engine lock.
   *
   * WHY: the off-chain engine + UI lock at `windowMs` (anti-snipe, unchanged), but a
   * real-money on-chain `place_bet` only lands after the client-side hold (BET_DELAY_MS,
   * ~5s) PLUS a devnet `confirmed` round-trip (up to ~4s with retries). If the operator
   * flipped the chain market to Locked at `windowMs` like the engine, that in-flight bet
   * would arrive after lock and fail with `MarketNotOpen` (0x1770). So we keep the chain
   * twin Open for this grace after the engine locks — long enough for the held tx to
   * confirm — while the client-side hold + `bettingClosesAt` remain the real anti-latency
   * defense. Default 0 (ANTI-SNIPE: lock the twin AT lockAt, no window for a known
   * outcome) — the program has no on-chain betting-close check, so any grace is exploitable.
   * See the runtime default + rationale at the CHAIN_LOCK_GRACE_MS line below.
   */
  chainLockGraceMs: number;
}

/** Parse a number from env with a fallback; ignores blank/garbage values. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a trimmed string from env with a fallback; blank → fallback. */
function string(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

/** Read a boolean flag from env: "1"/"true"/"yes"/"on" → true, else false. */
function bool(name: string): boolean {
  const flag = process.env[name]?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/** Parse the feed mode, defaulting to 'auto' for anything unexpected. */
function parseFeedMode(raw: string | undefined): FeedMode {
  return raw === 'sim' || raw === 'espn' || raw === 'auto' || raw === 'replay' ? raw : 'auto';
}

/** Default dual-lang for FIFA because Spanish ESPN commentary is denser; single EN elsewhere. */
function parseEspnCommentaryLang(
  raw: string | undefined,
  league: string,
): 'en' | 'es' | 'dual' {
  if (raw === 'en' || raw === 'es' || raw === 'dual') return raw;
  return league === 'fifa.world' ? 'dual' : 'en';
}

export const config: Config = {
  port: num('PORT', WS_DEFAULT_PORT),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  // Haiku 4.5 — fast + cheap, ideal for the "is this bettable?" decision on the
  // critical path of opening a market. (Sonnet id for reference: claude-sonnet-4-6.)
  aiModel: process.env.AI_MODEL?.trim() || 'claude-haiku-4-5-20251001',
  aiTimeoutMs: num('AI_TIMEOUT_MS', 4000),
  aiResolveTimeoutMs: num('AI_RESOLVE_TIMEOUT_MS', 6000),
  aiDirectorEnabled: (process.env.AI_DIRECTOR?.trim() || '') === '1',
  aiRefreshMs: num('AI_REFRESH_MS', 5000),
  aiMatchTokenBudget: num('AI_MATCH_TOKEN_BUDGET', 120000),
  minConfidence: num('MIN_CONFIDENCE', 0.6),
  feedMode: parseFeedMode(process.env.FEED_MODE?.trim()),
  espnLeague: process.env.ESPN_LEAGUE?.trim() || 'eng.1',
  espnCommentaryLang: parseEspnCommentaryLang(
    process.env.ESPN_COMMENTARY_LANG?.trim(),
    process.env.ESPN_LEAGUE?.trim() || 'eng.1',
  ),
  replayEventId: process.env.REPLAY_EVENT_ID?.trim() || '760437', // Croatia at England (WC)
  forceEventId: process.env.GOLAZO_EVENT_ID?.trim() || undefined,
  espnPollMs: num('ESPN_POLL_MS', 2500),
  pointsStorePath:
    process.env.POINTS_STORE_PATH === ''
      ? undefined
      : process.env.POINTS_STORE_PATH?.trim() || join(homedir(), '.golazo', 'points.json'),
  referralStorePath:
    process.env.REFERRAL_STORE_PATH === ''
      ? undefined
      : process.env.REFERRAL_STORE_PATH?.trim() || join(homedir(), '.golazo', 'referrals.snapshot.json'),
  referralPayoutBps: num('REFERRAL_PAYOUT_BPS', 100),
  referralAdminToken: process.env.REFERRAL_ADMIN_TOKEN?.trim() || undefined,
  rake: num('RAKE', 0.06),
  feeRecipient: process.env.FEE_RECIPIENT?.trim() || '5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP',
  // No house seed by default: a seeded pool has no Bet PDA, so its net share is paid to nobody
  // (strands funds) and dilutes real winners. Keep 0 unless a seed is explicitly funded + claimed.
  baseSeed: num('BASE_SEED', 0),
  liquidityBotsEnabled: bool('LIQUIDITY_BOTS'),
  botCount: num('BOT_COUNT', 24),
  pointsBotCount: num('POINTS_BOT_COUNT', 12),
  pointsBotMinStake: num('POINTS_BOT_MIN_STAKE', 8),
  pointsBotMaxStake: num('POINTS_BOT_MAX_STAKE', 60),
  resolveTimeoutMs: num('RESOLVE_TIMEOUT_MS', 12000),
  betDelayMs: num('BET_DELAY_MS', 5000),
  /** Paper bets use the same anti-snipe hold as real money unless overridden. */
  pointsBetDelayMs: num('POINTS_BET_DELAY_MS', 5000),
  betSafetyBufferMs: num('BET_SAFETY_BUFFER_MS', 2000),
  chainEnabled: bool('CHAIN_ENABLED'),
  operatorKeypair: process.env.OPERATOR_KEYPAIR?.trim() || undefined,
  solanaRpcUrl: string('SOLANA_RPC_URL', 'http://127.0.0.1:8899'),
  golazoProgramId: string('GOLAZO_PROGRAM_ID', '3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM'),
  chainSeedLamports: num('CHAIN_SEED_LAMPORTS', 0),
  // ANTI-SNIPE: 0 by default so the on-chain twin locks AT lockAt (the same instant the engine
  // locks), leaving NO window in which a known/held outcome can be bet with real USX. (It was 10s
  // to let an in-flight place_bet confirm, but the program has no on-chain betting-close check, so
  // ANY grace is an exploitable snipe window.) flushChainLock also freezes the twin the moment an
  // outcome is held. Only raise this with a redeployed program that enforces betting_closes_at.
  chainLockGraceMs: num('CHAIN_LOCK_GRACE_MS', 0),
};

/** One-line, secret-free summary for the boot log. */
export function describeConfig(c: Config): string {
  return [
    `port=${c.port}`,
    `feed=${c.feedMode}`,
    `league=${c.espnLeague}`,
    `espnLang=${c.espnCommentaryLang}`,
    `watcher=${c.anthropicApiKey ? `ai(${c.aiModel})` : 'rules(no ANTHROPIC_API_KEY)'}`,
    `rake=${c.rake} (fee→${c.feeRecipient.slice(0, 6)}…)`,
    `bots=${c.liquidityBotsEnabled ? `on(${c.botCount}/${c.pointsBotCount})` : 'off'}`,
    describeChain(c),
  ].join(' ');
}

/**
 * Summarise CHAIN MODE for the boot log: `chain=on(<pubkeyPrefix>…)` when the
 * operator wired up successfully, else `chain=off`. Probing the operator here
 * means the log reflects whether the keypair actually loaded, not just the flag.
 */
function describeChain(c: Config): string {
  if (!c.chainEnabled) return 'chain=off';
  const op = new FeedChainOperator({
    enabled: c.chainEnabled,
    operatorKeypair: c.operatorKeypair,
    rpcUrl: c.solanaRpcUrl,
    programId: c.golazoProgramId,
  });
  const pk = op.operatorPubkey?.toBase58();
  return pk ? `chain=on(${pk.slice(0, 6)}…)` : 'chain=off';
}
