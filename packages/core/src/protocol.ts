import type { GameState, Outcome, Side, Team } from './types';
import type { Market } from './engine';
import type { RoomMarket, RoomState } from './rooms';

/**
 * Wire protocol shared by the feed service (server) and the mobile app (client).
 * Both import these from @golazo/core so they can never drift.
 */

export type ServerMessage =
  | { t: 'game'; game: GameState }
  | { t: 'commentary'; text: string; ts: number }
  | { t: 'market_open'; market: Market }
  | { t: 'market_update'; market: Market } // pool / odds changed
  | { t: 'market_lock'; market: Market }
  | { t: 'market_resolve'; market: Market } // includes settlement w/ per-user payouts
  // A held bet was NOT accepted (the play resolved inside the bet-delay window, or
  // the market closed first). The client must refund its optimistic debit.
  | { t: 'bet_rejected'; marketId: string; userId: string; stake: number; reason: string }
  // ── Friends mode (rooms) ──────────────────────────────────────────────────
  // Authoritative room snapshot (players w/ points, phase, markets). Sent on join,
  // on any roster/points/phase change, and after every room market resolve.
  | { t: 'room_state'; state: RoomState }
  | { t: 'room_market_open'; code: string; market: RoomMarket }
  | { t: 'room_market_update'; code: string; market: RoomMarket } // a bet landed
  | { t: 'room_market_resolve'; code: string; market: RoomMarket } // outcome set
  | { t: 'room_error'; code?: string; message: string };

export type ClientMessage =
  | { t: 'hello'; userId: string }
  | { t: 'bet'; marketId: string; side: Side; stake: number; userId: string }
  // ── Friends mode (rooms) ──────────────────────────────────────────────────
  | { t: 'room_create'; userId: string; name: string }
  | { t: 'room_join'; userId: string; name: string; code: string }
  | { t: 'room_bet'; code: string; userId: string; marketId: string; side: Side; stake: number }
  | {
      t: 'room_make_market';
      code: string;
      userId: string;
      question: string;
      team?: Team;
      windowMs?: number;
    }
  | { t: 'room_resolve_market'; code: string; userId: string; marketId: string; outcome: Outcome }
  | { t: 'room_leave'; code: string; userId: string };

export const WS_DEFAULT_PORT = 8787;
