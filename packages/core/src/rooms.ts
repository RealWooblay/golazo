/**
 * FRIENDS MODE — in-app PRIVATE betting sessions (real $, bet against your friend).
 *
 * A host creates a room (short code + shareable invite link); a friend joins and
 * the two play the SAME live match the feed is running. This is the SAME
 * parimutuel mechanic as the main game — players bet AGAINST EACH OTHER into a
 * per-market pool — with three differences:
 *   • PRIVATE: only the friends in the room are in the pool (no bots).
 *   • SMALL FEE: a low ROOM_RAKE (2%) vs the main book's 6% — much smaller, but
 *     not free; it accrues to the treasury like the main rake.
 *   • SESSION NET: each player carries a running session PnL on the leaderboard
 *     (starts at 0). Real SOL stakes come from the wallet; wins/losses accrue as
 *     net after each market resolves. Claim on-chain after each market.
 *
 * AI markets from the live feed are MIRRORED into the room (empty pool the friends
 * bet into) and resolve in lockstep with the match; either player can also author
 * a "bet this moment" market the host/author settles by hand.
 *
 * Money: real SOL from the player's wallet. Room balances are session net PnL only
 * (not a separate tab). Friend markets settle on-chain when the host/author taps
 * YES / NO / VOID.
 *
 * The SERVER (services/feed) is authoritative for balances + room state; clients
 * render whatever the latest `RoomState` says and animate reveals for flavour.
 * Pure types + helpers only — no I/O, so feed and app share one source of truth.
 */
import type { Outcome, Side, Team, OnChainRef } from './types';
import type { MarketStatus } from './engine';
import { settle, type Pool, type Settlement } from './parimutuel';

export type RoomPhase = 'lobby' | 'live' | 'fulltime';
export type RoomMarketSource = 'ai' | 'friend';

/** Session PnL baseline — leaderboard starts at zero; stakes come from the wallet. */
export const ROOM_START_BALANCE = 0;
/** Length of the human-shareable room code. */
export const ROOM_CODE_LEN = 7;
/** Default betting window for a friend-authored "bet this moment" market. */
export const FRIEND_MARKET_WINDOW_MS = 30_000;
/** Private friends pool fee — small (2%) vs the main book's 6%. NOT free; the
 *  rake accrues to the treasury. Winners split the rest of the pool. */
export const ROOM_RAKE = 0.02;

export interface RoomPlayer {
  userId: string;
  name: string;
  /** Running session net PnL (wins − losses) — the leaderboard. */
  balance: number;
  isHost: boolean;
  connected: boolean;
  joinedAt: number;
}

export interface RoomBet {
  userId: string;
  side: Side;
  /** $ staked into this market's pool. */
  stake: number;
}

export interface RoomMarket {
  id: string;
  source: RoomMarketSource;
  /** Friend-made markets only: the player who created it. */
  authorId?: string;
  question: string;
  team?: Team;
  status: MarketStatus;
  /** Parimutuel pool formed from the friends' own bets (no seed, no house). */
  pool: Pool;
  openedAt: number;
  lockAt: number;
  windowMs: number;
  bets: RoomBet[];
  outcome?: Outcome;
  /** AI markets only: the global feed market id, so the server resolves in lockstep. */
  sourceMarketId?: string;
  /** On-chain twin for real-SOL betting in chain mode (private per-room market). */
  onChain?: OnChainRef;
}

export interface RoomState {
  code: string;
  /** The feed game this room is overlaid on (display only). */
  matchId: string;
  phase: RoomPhase;
  hostId: string;
  players: RoomPlayer[];
  /** Open + recently-resolved markets (server caps the history it sends). */
  markets: RoomMarket[];
  createdAt: number;
}

/**
 * Settle a room market — parimutuel among the friends, small ROOM_RAKE fee. Winners
 * split the pool by stake share; losers' stakes fund the winners.
 *
 * One-sided guard: if the winning side has NO stake (nobody took it), the market
 * is refunded (VOID-like) so a friend never loses a stake with no counterparty.
 * Returns a core `Settlement` whose `payouts[]` is the $ to credit each player.
 */
export function settleRoomMarket(
  market: RoomMarket,
  outcome: Outcome,
): Settlement {
  const winnerStake =
    outcome === 'YES' ? market.pool.yes : outcome === 'NO' ? market.pool.no : 0;
  const effective: Outcome =
    outcome !== 'VOID' && winnerStake <= 0 ? 'VOID' : outcome;
  return settle(market.pool, market.bets, effective, ROOM_RAKE);
}

/** Generate a short, unambiguous room code (no 0/O/1/I/L). Pass a RNG for tests. */
export function makeRoomCode(rand: () => number = Math.random, len = ROOM_CODE_LEN): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}
