/**
 * RoomManager — server-side state + logic for FRIENDS MODE private rooms.
 *
 * A host creates a room (short code); a friend joins and they play the SAME
 * live match the feed is running. This is REAL-$ PARIMUTUEL among the friends —
 * the same mechanic as the main game, just private: each market's pool forms
 * from the friends' OWN bets, winners split the pool, and there is NO house and
 * a small ROOM_RAKE (2%). Every player carries session net PnL on the leaderboard
 * (starts at 0); real SOL stakes come from the wallet and settle on-chain per market.
 *
 *   • AI markets: the orchestrator MIRRORS each global live-match market into
 *     every active room (source 'ai', EMPTY pool the friends bet into) and
 *     resolves them in LOCKSTEP with the global market via the relay hooks below.
 *   • Friend markets: either player authors a "bet this moment" market (EMPTY
 *     pool, default 30s window), resolved by the room HOST or the AUTHOR by hand.
 *
 * Settlement is parimutuel + rake-free via core's `settleRoomMarket`, which also
 * REFUNDS a one-sided market (winning side had no stake) so a friend never loses
 * a stake with no counterparty.
 *
 * This class is PURE logic + state — it owns NO sockets. The server gives it a
 * single `emit(code, ServerMessage)` sink at construction; the manager calls
 * that to push room_state / room_market_* frames (the server fans them out to
 * the room's sockets). Mutations triggered by a client message return the
 * resulting RoomState (or a RoomError) so the server can also reply on the
 * offending socket; relay-driven mutations (AI markets) only use `emit`.
 *
 * The server (this service) is AUTHORITATIVE for balances + room state. Clients
 * never compute balances — they render whatever the latest RoomState says.
 */

import {
  FRIEND_MARKET_WINDOW_MS,
  ROOM_START_BALANCE,
  makeRoomCode,
  settleRoomMarket,
  type Market,
  type OnChainRef,
  type Outcome,
  type RoomBet,
  type RoomMarket,
  type RoomPlayer,
  type RoomState,
  type ServerMessage,
  type Side,
  type Team,
} from '@golazo/core';

/** Rooms with no connected players are purged after this idle window. */
const ROOM_TTL_MS = 30 * 60_000;

/** Max markets included in a broadcast RoomState (newest last). */
const ROOM_MARKET_HISTORY = 12;

/** Max players in a private room. Head-to-head is the common case, but a small
 *  group still works (parimutuel pools + leaderboard scale fine). */
const MAX_ROOM_PLAYERS = 8;

/** The room messages a mutation produced, for the server to broadcast. */
export interface RoomEffects {
  /** Updated room snapshot to send to the whole room (absent on error). */
  state?: RoomState;
  /** A single market open/update/resolve to fan out to the whole room. */
  markets: ServerMessage[];
  /** An error to send ONLY to the offending socket. */
  error?: { code?: string; message: string };
}

/** Internal room record — the full (uncapped) market list lives here. */
interface Room {
  code: string;
  matchId: string;
  hostId: string;
  players: Map<string, RoomPlayer>;
  /** Full market history; getRoomState caps what we actually send. */
  markets: RoomMarket[];
  createdAt: number;
  /** Whether the feed currently has a live match (drives 'lobby' vs 'live'). */
  liveAtCreate: boolean;
  /** Last client activity — used to expire idle rooms. */
  lastActivityAt: number;
}

export interface RoomManagerDeps {
  emit: (code: string, msg: ServerMessage) => void;
  matchId: () => string;
  isLive: () => boolean;
  isFinal: () => boolean;
  now?: () => number;
  rand?: () => number;
  /** When set, room markets get on-chain twins and balances track session PnL. */
  chain?: RoomChainBridge | null;
}

/** Injected chain operator hooks — keeps RoomManager socket-free. */
export interface RoomChainBridge {
  active: boolean;
  authority: string | null;
  nextSeed: () => number;
  rakeBps: number;
  seedLamports: number;
  initMarket: (args: {
    marketSeed: number;
    questionText: string;
  }) => Promise<unknown>;
  lockMarket: (seed: number) => void;
  resolveMarket: (seed: number, outcome: Outcome) => void;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly rand: () => number;
  private chain: RoomChainBridge | null;
  private marketSeq = 0;
  /** Per-room on-chain seed tracking for lock/resolve. */
  private readonly roomSeeds = new Map<string, number>();

  constructor(private readonly deps: RoomManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? Math.random;
    this.chain = deps.chain ?? null;
  }

  /** Late-bind chain bridge (orchestrator wires this at start). */
  configureChain(chain: RoomChainBridge | null): void {
    this.chain = chain;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  // -------------------------------------------------------------------------
  // Room lifecycle (client-driven)
  // -------------------------------------------------------------------------

  /** Create a fresh room with `userId` as host. Always succeeds. */
  createRoom(userId: string, name: string): RoomEffects {
    const code = this.uniqueCode();
    const host: RoomPlayer = {
      userId,
      name: cleanName(name),
      balance: ROOM_START_BALANCE,
      isHost: true,
      connected: true,
      joinedAt: this.now(),
    };
    const room: Room = {
      code,
      matchId: this.deps.matchId(),
      hostId: userId,
      players: new Map([[userId, host]]),
      markets: [],
      createdAt: this.now(),
      liveAtCreate: this.deps.isLive(),
      lastActivityAt: this.now(),
    };
    this.rooms.set(code, room);
    this.backfillGlobalMarket(room);
    return this.broadcastState(room);
  }

  /**
   * Join an existing room. Idempotent: the same userId rejoining just marks
   * them connected (so a reconnect or two tabs of the same uid don't duplicate).
   */
  joinRoom(code: string, userId: string, name: string): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return errorEffect('No room with that code', code);

    const existing = room.players.get(userId);
    if (existing) {
      existing.connected = true;
      existing.name = cleanName(name) || existing.name;
      return this.broadcastState(room);
    }

    // Private session — cap at a small group. (Idempotent rejoin above is the
    // escape hatch for reconnects of an already-seated player.)
    if (room.players.size >= MAX_ROOM_PLAYERS)
      return errorEffect('Room is full', room.code);

    const player: RoomPlayer = {
      userId,
      name: cleanName(name),
      balance: ROOM_START_BALANCE,
      isHost: false,
      connected: true,
      joinedAt: this.now(),
    };
    room.players.set(userId, player);
    room.lastActivityAt = this.now();
    this.backfillGlobalMarket(room);
    return this.broadcastState(room);
  }

  /** Mark a player disconnected. Rooms stay alive so friends can still join after a
   *  brief socket drop (mobile browsers kill WS on background). Cleanup happens on
   *  explicit leave or when the room sits empty for ROOM_TTL_MS. */
  disconnect(code: string, userId: string): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return { markets: [] };
    const player = room.players.get(userId);
    if (!player) return { markets: [] };
    player.connected = false;
    room.lastActivityAt = this.now();
    return this.broadcastState(room);
  }

  /** Explicit leave (room_leave): remove the player entirely, drop empty rooms. */
  leave(code: string, userId: string): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return { markets: [] };
    if (!room.players.delete(userId)) return { markets: [] };

    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return { markets: [] };
    }
    room.lastActivityAt = this.now();
    // If the host left, hand the host badge to whoever remains (host resolves
    // friend markets, so the room must always have one).
    if (room.hostId === userId) {
      const next = [...room.players.values()][0];
      if (next) {
        next.isHost = true;
        room.hostId = next.userId;
      }
    }
    return this.broadcastState(room);
  }

  // -------------------------------------------------------------------------
  // Betting + friend markets (client-driven)
  // -------------------------------------------------------------------------

  /**
   * Place a $ bet into an OPEN market's pool within its window. One bet per
   * player per market; stake must be ≤ the player's balance. The stake is added
   * to that side of the pool and debited from the player's balance immediately
   * (the server is authoritative — clients only animate). There is no locked
   * odds/mult: the eventual payout is the parimutuel pool share at settlement.
   */
  placeBet(code: string, userId: string, marketId: string, side: Side, stake: number): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return errorEffect('No room with that code', code);
    const player = room.players.get(userId);
    if (!player) return errorEffect('You are not in this room', room.code);

    const market = room.markets.find((m) => m.id === marketId);
    if (!market) return errorEffect('Unknown market', room.code);
    if (market.status !== 'open') return errorEffect('Market is closed', room.code);
    if (this.now() > market.lockAt) return errorEffect('Betting window has closed', room.code);
    if (market.bets.some((b) => b.userId === userId)) {
      return errorEffect('You already bet on this market', room.code);
    }
    if (!Number.isFinite(stake) || stake <= 0) return errorEffect('Stake must be positive', room.code);

    if (!this.chain?.active) {
      if (stake > player.balance) return errorEffect('Not enough balance', room.code);
      player.balance -= stake;
    }

    if (side === 'YES') market.pool.yes += stake;
    else market.pool.no += stake;
    const bet: RoomBet = { userId, side, stake };
    market.bets.push(bet);

    const effects = this.broadcastState(room);
    return this.withMarketMessage(room, effects, 'room_market_update', market);
  }

  /**
   * Author a friend "bet this moment" market: EMPTY parimutuel pool, default 30s
   * window, status 'open'. Either seated player may create one.
   */
  makeMarket(
    code: string,
    userId: string,
    question: string,
    team?: Team,
    windowMs?: number,
  ): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return errorEffect('No room with that code', code);
    if (!room.players.has(userId)) return errorEffect('You are not in this room', room.code);
    const q = cleanQuestion(question);
    if (!q) return errorEffect('Question cannot be empty', room.code);
    if (this.hasActiveMarket(room)) {
      return errorEffect('Finish the current market first', room.code);
    }

    const openedAt = this.now();
    const window = sanitizeWindow(windowMs);
    const market: RoomMarket = {
      id: this.nextMarketId(),
      source: 'friend',
      authorId: userId,
      question: q,
      ...(team ? { team } : {}),
      status: 'open',
      pool: { yes: 0, no: 0 },
      openedAt,
      lockAt: openedAt + window,
      windowMs: window,
      bets: [],
    };
    room.markets.push(market);
    this.stampOnChain(market);

    const effects = this.broadcastState(room);
    return this.withMarketMessage(room, effects, 'room_market_open', market);
  }

  /**
   * Resolve a FRIEND market by hand — ONLY the room host or the market's author
   * may do this. Settles the pool parimutuel via settleRoomMarket and credits
   * each player's balance, then re-broadcasts. (AI markets resolve via the relay
   * hooks, not here.)
   */
  resolveMarket(code: string, userId: string, marketId: string, outcome: Outcome): RoomEffects {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return errorEffect('No room with that code', code);
    if (!room.players.has(userId)) return errorEffect('You are not in this room', room.code);

    const market = room.markets.find((m) => m.id === marketId);
    if (!market) return errorEffect('Unknown market', room.code);
    if (market.source !== 'friend') {
      return errorEffect('AI markets resolve automatically', room.code);
    }
    if (market.status === 'resolved' || market.status === 'void') {
      return errorEffect('Market already resolved', room.code);
    }
    const isHost = room.hostId === userId;
    const isAuthor = market.authorId === userId;
    if (!isHost && !isAuthor) {
      return errorEffect('Only the host or author can resolve this', room.code);
    }

    this.settleMarket(room, market, outcome);
    const effects = this.broadcastState(room);
    return this.withMarketMessage(room, effects, 'room_market_resolve', market);
  }

  // -------------------------------------------------------------------------
  // AI relay hooks (orchestrator-driven, fire outside any client request)
  // -------------------------------------------------------------------------

  /**
   * Mirror a freshly-opened GLOBAL market into every active room as an AI
   * RoomMarket with an EMPTY parimutuel pool the friends bet into. Window/lockAt
   * mirror the global market so the room locks in lockstep. We do NOT use the
   * global trueProb/odds — the room pool stands alone. Broadcasts room_state +
   * room_market_open to each room via `emit`.
   */
  onGlobalMarketOpen(global: Market): void {
    for (const room of this.rooms.values()) {
      this.mirrorGlobalMarket(room, global);
    }
  }

  /** Lock the mirrored AI market in every room when the global market locks. */
  onGlobalMarketLock(globalId: string): void {
    for (const room of this.rooms.values()) {
      const market = room.markets.find((m) => m.sourceMarketId === globalId);
      if (!market || market.status !== 'open') continue;
      market.status = 'locked';
      this.lockOnChain(market);
      this.emitState(room);
      this.deps.emit(room.code, { t: 'room_market_update', code: room.code, market });
    }
  }

  /**
   * Resolve the mirrored AI market in every room with the global market's
   * settled outcome and credit each player's balance. One-sided/VOID-safe:
   * settleRoomMarket refunds when the winning side has no stake.
   */
  onGlobalMarketResolve(global: Market): void {
    const outcome = global.settlement?.outcome;
    if (!outcome) return; // nothing to mirror without a settled outcome
    for (const room of this.rooms.values()) {
      const market = room.markets.find((m) => m.sourceMarketId === global.id);
      if (!market || market.status === 'resolved' || market.status === 'void') continue;
      this.settleMarket(room, market, outcome);
      this.emitState(room);
      this.deps.emit(room.code, { t: 'room_market_resolve', code: room.code, market });
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Public snapshot of a room (markets capped to the recent history window). */
  getRoomState(code: string): RoomState | undefined {
    const room = this.rooms.get(normalizeCode(code));
    return room ? this.snapshot(room) : undefined;
  }

  /** Whether a room with this code exists (server uses this for routing). */
  has(code: string): boolean {
    return this.rooms.has(normalizeCode(code));
  }

  /** Active room codes — handy for tests/telemetry. */
  codes(): string[] {
    this.purgeIdleRooms();
    return [...this.rooms.keys()];
  }

  /** Drop rooms that have had no connected players for ROOM_TTL_MS. */
  purgeIdleRooms(): void {
    const cutoff = this.now() - ROOM_TTL_MS;
    for (const [code, room] of this.rooms) {
      const anyoneConnected = [...room.players.values()].some((p) => p.connected);
      if (!anyoneConnected && room.lastActivityAt < cutoff) {
        this.rooms.delete(code);
      }
    }
  }

  /** Lock friend-authored markets whose betting window has elapsed. */
  lockExpiredMarkets(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const market of room.markets) {
        if (market.source !== 'friend' || market.status !== 'open' || now <= market.lockAt) continue;
        market.status = 'locked';
        this.lockOnChain(market);
        this.deps.emit(room.code, { t: 'room_market_update', code: room.code, market });
        changed = true;
      }
      if (changed) this.emitState(room);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** True when the room already has an open or locked market (one at a time). */
  private hasActiveMarket(room: Room): boolean {
    return room.markets.some((m) => m.status === 'open' || m.status === 'locked');
  }

  /** Late join / create: copy the current global AI market if the room is idle. */
  private backfillGlobalMarket(room: Room): void {
    const global = this.deps.getOpenGlobalMarket?.();
    if (!global) return;
    this.mirrorGlobalMarket(room, global);
  }

  /**
   * Mirror a global market into one room. Skips when the room is busy or already
   * has this global id — friend markets are never overwritten.
   */
  private mirrorGlobalMarket(room: Room, global: Market): void {
    if (this.hasActiveMarket(room)) return;
    if (room.markets.some((m) => m.sourceMarketId === global.id)) return;
    const market: RoomMarket = {
      id: this.nextMarketId(),
      source: 'ai',
      question: global.question,
      ...(global.team ? { team: global.team } : {}),
      status: global.status === 'locked' ? 'locked' : 'open',
      pool: { yes: 0, no: 0 },
      openedAt: global.openedAt,
      lockAt: global.lockAt,
      windowMs: global.windowMs,
      bets: [],
      sourceMarketId: global.id,
    };
    room.markets.push(market);
    this.stampOnChain(market);
    if (market.status === 'locked') this.lockOnChain(market);
    this.emitState(room);
    this.deps.emit(room.code, {
      t: market.status === 'open' ? 'room_market_open' : 'room_market_update',
      code: room.code,
      market,
    });
  }

  /**
   * Settle a market parimutuel for `outcome` and credit each payout to that
   * player's balance, then stamp it resolved/void. Uses core's settleRoomMarket
   * (rake-free; refunds a one-sided market). Settlement.payouts[].payout is the
   * exact $ to CREDIT each player.
   */
  private settleMarket(room: Room, market: RoomMarket, outcome: Outcome): void {
    const settlement = settleRoomMarket(market, outcome);
    for (const p of settlement.payouts) {
      const player = room.players.get(p.userId);
      if (!player) continue;
      const bet = market.bets.find((b) => b.userId === p.userId && b.side === p.side);
      const stake = bet?.stake ?? 0;
      player.balance += this.chain?.active ? p.payout - stake : p.payout;
    }
    market.outcome = settlement.outcome;
    market.status = settlement.outcome === 'VOID' ? 'void' : 'resolved';
    this.resolveOnChain(market, settlement.outcome);
  }

  private stampOnChain(market: RoomMarket): void {
    if (!this.chain?.active || !this.chain.authority) return;
    const marketSeed = this.chain.nextSeed();
    const onChain: OnChainRef = { marketSeed, authority: this.chain.authority };
    market.onChain = onChain;
    this.roomSeeds.set(market.id, marketSeed);
    void this.chain.initMarket({ marketSeed, questionText: market.question });
  }

  private lockOnChain(market: RoomMarket): void {
    const seed = this.roomSeeds.get(market.id);
    if (seed !== undefined) this.chain?.lockMarket(seed);
  }

  private resolveOnChain(market: RoomMarket, outcome: Outcome): void {
    const seed = this.roomSeeds.get(market.id);
    if (seed === undefined) return;
    if (outcome === 'VOID') this.chain?.resolveMarket(seed, 'VOID');
    else this.chain?.resolveMarket(seed, outcome);
    this.roomSeeds.delete(market.id);
  }

  /** Build a public RoomState (phase derived from feed liveness, markets capped). */
  private snapshot(room: Room): RoomState {
    const players = [...room.players.values()].sort(
      // Leaderboard order: balance desc, then by join time for a stable tie-break.
      (a, b) => b.balance - a.balance || a.joinedAt - b.joinedAt,
    );
    const markets = room.markets.slice(-ROOM_MARKET_HISTORY);
    return {
      code: room.code,
      matchId: room.matchId,
      phase: this.deps.isFinal()
        ? 'fulltime'
        : room.liveAtCreate || this.deps.isLive()
          ? 'live'
          : 'lobby',
      hostId: room.hostId,
      players,
      markets,
      createdAt: room.createdAt,
    };
  }

  /** Emit a room_state to the whole room (used by relay hooks). */
  private emitState(room: Room): void {
    this.deps.emit(room.code, { t: 'room_state', state: this.snapshot(room) });
  }

  /** Produce a RoomEffects carrying the snapshot to broadcast as room_state. */
  private broadcastState(room: Room): RoomEffects {
    return { state: this.snapshot(room), markets: [] };
  }

  /** Append a market lifecycle message to an effects bundle. */
  private withMarketMessage(
    room: Room,
    effects: RoomEffects,
    t: 'room_market_open' | 'room_market_update' | 'room_market_resolve',
    market: RoomMarket,
  ): RoomEffects {
    effects.markets.push({ t, code: room.code, market });
    return effects;
  }

  private nextMarketId(): string {
    return `room_mkt_${++this.marketSeq}`;
  }

  /** A room has no connected sockets — used only for TTL cleanup, not instant delete. */
  private isAbandoned(room: Room): boolean {
    for (const p of room.players.values()) if (p.connected) return false;
    return true;
  }

  /** Generate a code not currently in use. */
  private uniqueCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode(this.rand);
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely; widen the code rather than ever collide.
    let code = makeRoomCode(this.rand, 6);
    while (this.rooms.has(code)) code = makeRoomCode(this.rand, 6);
    return code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Room codes are uppercase + trimmed everywhere we look one up. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function errorEffect(message: string, code?: string): RoomEffects {
  return { markets: [], error: code ? { code, message } : { message } };
}

/** Trim + cap a display name; the WS boundary trusts nothing. */
function cleanName(name: string): string {
  return typeof name === 'string' ? name.trim().slice(0, 40) : '';
}

/** Trim + cap a friend market's question. */
function cleanQuestion(question: string): string {
  return typeof question === 'string' ? question.trim().slice(0, 140) : '';
}

/** Clamp a friend-market window to a sane range; default 30s. */
function sanitizeWindow(windowMs: number | undefined): number {
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    return FRIEND_MARKET_WINDOW_MS;
  }
  return Math.min(5 * 60_000, Math.max(5_000, Math.round(windowMs)));
}
