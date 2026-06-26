import type { MarketSlot, Outcome, Side } from "@golazo/core";

/**
 * STATE TYPES — the typed contract every feature imports.
 *
 * Two layers live here:
 *   1. UI view models (MarketVM/PendingBet/RevealVM) — flattened engine state the
 *      match screen draws. Decoupled from @golazo/core so components never touch
 *      pools/seeds/bet arrays.
 *   2. Persisted ledger types (BetRow/TransactionRow/HistoryItem) — the unified
 *      history shown on the Profile screen and persisted across launches.
 *
 * Feature agents: import the ledger types from '@/state' and append rows via the
 * store actions (addBet / addTransaction). Do not invent parallel shapes.
 */

// ── Feed / market view models ────────────────────────────────────────────────

/** Which feed the app is running against. */
export type FeedMode = "offline" | "live";

/** Real money (SOL/play $) vs server-authoritative play points. */
export type MoneyMode = "real" | "points";

/** Phase of the on-screen market card. */
export type MarketPhase = "idle" | "open" | "locked" | "resolved";

/** One active or recently-settled market, flattened for the UI. */
export interface MarketVM {
  id: string;
  question: string; // "Argentina on the attack — GOAL?"
  subtitle: string; // the raw commentary line that opened it
  slot?: MarketSlot;
  /** Engine market kind (shot_in_window, goal_from_corner, player_to_score…) —
   *  drives the lane tag + the honest YES/NO labels on the card. */
  kind?: string;
  team: "home" | "away" | undefined;
  phase: MarketPhase;
  /** Live implied multiples from the pool (move as money comes in). */
  oddsYes: number;
  oddsNo: number;
  pool: number; // gross pool in dollars
  yesShare: number; // 0..100 — width of the YES portion of the split bar
  /** Distinct bettors in this market's pool right now (you + the crowd) — the
   *  real "active players" figure surfaced on the public-game affordance. */
  participants: number;
  openedAt: number;
  lockAt: number;
  windowMs: number;
  /** Ms after lockAt before force-settle — drives the locked countdown ring. */
  resolveWindowMs: number;
  /** Absolute deadline once betting closes (lockAt + resolveWindowMs). */
  resolveAt: number;
  /**
   * On-chain twin identity (only in CHAIN MODE) — the operator authority + the
   * market_seed for the program PDAs. Present → the app places REAL bets on it.
   */
  onChain?: { marketSeed: number; authority: string };
}

/** The user's bet on a market, with a non-guaranteed tap-time estimate. */
export interface PendingBet {
  marketId: string;
  side: Side;
  stake: number;
  /** Estimated multiple at tap time. Final payout floats with the pool until lock. */
  estimatedMult: number;
}

/** Result of a settled market, fed into the tap-to-reveal card + history. */
export interface RevealVM {
  marketId: string;
  question: string;
  kind?: string;
  team: "home" | "away" | undefined;
  side: Side;
  stake: number;
  payoutMult: number;
  outcome: Outcome;
  won: boolean;
  payout: number; // 0 on a loss; stake on a VOID refund; capped win otherwise
  /** POINTS mode only: the new balance to apply WHEN this reveal is tapped (reveal = claim,
   *  matching real money). Undefined for real-money reveals (those credit via `payout`). */
  claimBalance?: number;
}

/** A settled market in this session — final pool + odds, whether or not you bet. */
export interface ClosedMarketVM {
  marketId: string;
  question: string;
  kind?: string;
  outcome: Outcome;
  oddsYes: number;
  oddsNo: number;
  poolYes: number;
  poolNo: number;
  poolTotal: number;
  yesShare: number;
  settledAt: number;
  /** Set when you had a bet on this market — highlights your side in the list. */
  userSide?: Side;
  /** Stake locked in when the market settled (from your pending bet). */
  userStake?: number;
  /** Net P/L for this market (+profit, −stake on loss, 0 void). */
  userDelta?: number;
  /** When you acknowledged the reveal (bet markets); drives session list order. */
  revealedAt?: number;
  /** Short human reason this market was voided/refunded (set only on voids). */
  voidReason?: string;
}

// ── Persisted ledger (Profile screen + history) ──────────────────────────────

/** Mode a deposit/withdrawal moved money through. Sandbox = play-money faucet. */
export type DepositMethod = "sandbox" | "card" | "crypto" | "apple_pay";
export type WithdrawDestination = "sandbox" | "bank" | "crypto";
export type TransactionStatus = "pending" | "complete" | "failed";

/**
 * A settled bet, persisted. Supersedes the old `HistoryRow` (kept as an alias
 * below for the current match components until the match agent migrates).
 */
export interface BetRow {
  kind: "bet";
  id: string; // unique row id
  marketId: string;
  /** The game this bet was on — lets a match screen show only THIS match's run. */
  gameId?: string;
  /** "YES · Argentina attack" — human label for the row. */
  label: string;
  question?: string; // full market question, if available
  side: Side;
  stake: number;
  payoutMult: number;
  outcome: Outcome;
  won: boolean;
  /** Signed net for display: +payout, −stake, or $0 on a void refund. */
  delta: number;
  /** epoch ms when the bet settled. */
  at: number;
}

/** A money movement (deposit or withdrawal), persisted. */
export interface TransactionRow {
  kind: "transaction";
  id: string;
  type: "deposit" | "withdraw";
  amount: number; // always positive; `delta` carries the sign
  delta: number; // +amount for deposit, −amount for withdraw
  method?: DepositMethod;
  destination?: WithdrawDestination;
  status: TransactionStatus;
  at: number; // epoch ms
}

/** The unified ledger row — either a bet or a transaction. Discriminate on `kind`. */
export type HistoryItem = BetRow | TransactionRow;
