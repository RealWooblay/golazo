/**
 * Realtime server: WebSocket broadcast + a tiny HTTP surface.
 *
 * The mobile app connects over WS and receives `ServerMessage`s (game state,
 * commentary, market open/update/lock/resolve). It sends `ClientMessage`s:
 *   - { t:'hello', userId }                    : identify the socket.
 *   - { t:'bet', marketId, side, stake, userId}: join the REAL pool.
 *
 * On a `bet` we call `engine.placeBet` — the user shares the exact same pool as
 * the bots. The resulting `update` (and later `resolve` with the full settlement
 * + per-user payouts) is broadcast by the orchestrator, so the app can credit the
 * user from the `market_resolve` message.
 *
 * HTTP: `GET /health` for liveness and `GET /state` for a JSON snapshot
 * (current game + open markets) — handy for curl/debugging without a WS client.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, GameState, Market, MarketEngine } from '@golazo/core';
import { RoomManager, type RoomEffects } from './rooms';

/** Callback the orchestrator supplies to handle an authenticated user bet. */
export type BetHandler = (msg: Extract<ClientMessage, { t: 'bet' }>) => void;

export interface FeeSnapshot {
  recipient: string;
  rakeBps: number;
  collected: number;
  marketsSettled: number;
}

export interface ServerDeps {
  port: number;
  engine: MarketEngine;
  /** Snapshot accessor for the current game state (for /state + hello replay). */
  getGame: () => GameState;
  /** Called when a client sends a valid `bet` message. */
  onBet: BetHandler;
  /** Current treasury fee snapshot (for /state + /fees). */
  getFees: () => FeeSnapshot;
}

/** What socket belongs to which room/player (cleaned up on close). */
interface SocketRoom {
  code: string;
  userId: string;
}

export class FeedServer {
  private readonly http = createServer((req, res) => this.handleHttp(req, res));
  private readonly wss = new WebSocketServer({ server: this.http });
  private readonly clients = new Set<WebSocket>();

  /** Sockets subscribed to each room code, for room-scoped fan-out. */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  /** Reverse index: which room/player a socket is registered as. */
  private readonly socketRoom = new WeakMap<WebSocket, SocketRoom>();

  /**
   * Owns FRIENDS-MODE room state. The manager is socket-free: it emits via the
   * broadcastRoom sink we inject here, so relay-driven (AI) updates reach rooms
   * the same way client-driven ones do. The orchestrator reaches it through
   * `server.roomManager` to fire the AI relay hooks.
   */
  readonly roomManager: RoomManager;

  constructor(private readonly deps: ServerDeps) {
    this.roomManager = new RoomManager({
      emit: (code, msg) => this.broadcastRoom(code, msg),
      matchId: () => this.deps.getGame().gameId,
      isLive: () => this.deps.getGame().status === 'live',
    });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  /** Start listening. Resolves once the port is bound. */
  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(this.deps.port, () => resolve());
    });
  }

  /**
   * Broadcast a `ServerMessage` to every connected client. JSON is serialized
   * once and reused for all sockets.
   */
  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /**
   * Broadcast a `ServerMessage` to every socket currently in `code`'s room.
   * Injected into the RoomManager as its `emit` sink and used by the
   * orchestrator's relay path. No-op for an unknown/empty room.
   */
  broadcastRoom(code: string, msg: ServerMessage): void {
    const set = this.rooms.get(code);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  async close(): Promise<void> {
    for (const ws of this.clients) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);

    // Send the current game state immediately so a freshly-connected app has
    // something to render before the next feed tick.
    ws.send(JSON.stringify({ t: 'game', game: this.deps.getGame() } satisfies ServerMessage));
    // Replay currently-open markets so a late joiner can bet right away.
    for (const m of this.deps.engine.list()) {
      if (m.status === 'open') {
        ws.send(JSON.stringify({ t: 'market_open', market: m } satisfies ServerMessage));
      }
    }

    ws.on('message', (raw) => this.handleClientMessage(ws, raw.toString()));
    ws.on('close', () => this.handleClose(ws));
    // Never let a socket-level error take down the process.
    ws.on('error', () => this.handleClose(ws));
  }

  /** Socket gone: drop it everywhere and mark its room player disconnected. */
  private handleClose(ws: WebSocket): void {
    this.clients.delete(ws);
    const reg = this.socketRoom.get(ws);
    if (!reg) return;
    this.socketRoom.delete(ws);
    const set = this.rooms.get(reg.code);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.rooms.delete(reg.code);
    }
    // Tell the manager; broadcast the resulting state to whoever's left.
    const effects = this.roomManager.disconnect(reg.code, reg.userId);
    if (effects.state) this.broadcastRoom(reg.code, { t: 'room_state', state: effects.state });
  }

  /** Parse + dispatch a single client message. Malformed input is ignored. */
  private handleClientMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // ignore non-JSON
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'hello':
        // Nothing stateful to track for the demo; ack with a fresh game frame.
        ws.send(JSON.stringify({ t: 'game', game: this.deps.getGame() } satisfies ServerMessage));
        return;
      case 'bet':
        if (!isValidBet(msg)) return;
        try {
          this.deps.onBet(msg);
        } catch {
          // placeBet may throw (market locked, bad stake); the broadcast simply
          // won't include this bet. Don't crash on user input.
        }
        return;
      case 'room_create':
      case 'room_join':
      case 'room_bet':
      case 'room_make_market':
      case 'room_resolve_market':
      case 'room_leave':
        this.handleRoomMessage(ws, msg);
        return;
      default:
        return;
    }
  }

  /**
   * Dispatch a room_* message to the RoomManager, (un)register the socket's room
   * membership, and fan out the result: room_state to the whole room, any
   * room_market_* to the whole room, and room_error ONLY to this socket.
   */
  private handleRoomMessage(ws: WebSocket, msg: RoomClientMessage): void {
    let effects: RoomEffects;
    switch (msg.t) {
      case 'room_create':
        if (!isNonEmptyStr(msg.userId)) return;
        effects = this.roomManager.createRoom(msg.userId, asStr(msg.name));
        this.registerSocket(ws, effects, msg.userId);
        break;
      case 'room_join':
        if (!isNonEmptyStr(msg.userId) || !isNonEmptyStr(msg.code)) return;
        effects = this.roomManager.joinRoom(msg.code, msg.userId, asStr(msg.name));
        this.registerSocket(ws, effects, msg.userId);
        break;
      case 'room_bet':
        if (!isValidRoomBet(msg)) return;
        effects = this.roomManager.placeBet(msg.code, msg.userId, msg.marketId, msg.side, msg.stake);
        break;
      case 'room_make_market':
        if (!isNonEmptyStr(msg.code) || !isNonEmptyStr(msg.userId)) return;
        effects = this.roomManager.makeMarket(
          msg.code,
          msg.userId,
          asStr(msg.question),
          msg.team,
          msg.windowMs,
        );
        break;
      case 'room_resolve_market':
        if (!isValidRoomResolve(msg)) return;
        effects = this.roomManager.resolveMarket(msg.code, msg.userId, msg.marketId, msg.outcome);
        break;
      case 'room_leave':
        if (!isNonEmptyStr(msg.code) || !isNonEmptyStr(msg.userId)) return;
        this.unregisterSocket(ws, msg.code);
        effects = this.roomManager.leave(msg.code, msg.userId);
        break;
    }
    this.dispatchRoomEffects(ws, effects);
  }

  /** Register a socket into the room it just created/joined (if it succeeded). */
  private registerSocket(ws: WebSocket, effects: RoomEffects, userId: string): void {
    const code = effects.state?.code;
    if (!code) return; // error (no state) — nothing to subscribe to
    // A socket only belongs to one room at a time.
    const prev = this.socketRoom.get(ws);
    if (prev && prev.code !== code) this.removeFromRoom(ws, prev.code);
    let set = this.rooms.get(code);
    if (!set) {
      set = new Set();
      this.rooms.set(code, set);
    }
    set.add(ws);
    this.socketRoom.set(ws, { code, userId });
  }

  /** Take a socket out of a room on an explicit leave. */
  private unregisterSocket(ws: WebSocket, code: string): void {
    const norm = code.trim().toUpperCase();
    this.removeFromRoom(ws, norm);
    const reg = this.socketRoom.get(ws);
    if (reg && reg.code === norm) this.socketRoom.delete(ws);
  }

  private removeFromRoom(ws: WebSocket, code: string): void {
    const set = this.rooms.get(code);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.rooms.delete(code);
  }

  /** Fan out a manager result: errors to the offender, state/markets to the room. */
  private dispatchRoomEffects(ws: WebSocket, effects: RoomEffects): void {
    if (effects.error) {
      const err: ServerMessage = effects.error.code
        ? { t: 'room_error', code: effects.error.code, message: effects.error.message }
        : { t: 'room_error', message: effects.error.message };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(err));
      return;
    }
    if (effects.state) {
      this.broadcastRoom(effects.state.code, { t: 'room_state', state: effects.state });
    }
    for (const m of effects.markets) {
      // room_market_* messages all carry a `code` in this union.
      const code = 'code' in m && typeof m.code === 'string' ? m.code : undefined;
      if (code) this.broadcastRoom(code, m);
    }
  }

  /** GET /health and GET /state; everything else is 404. */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: this.clients.size }));
      return;
    }
    if (url === '/state') {
      const openMarkets = this.deps.engine.list().filter((m: Market) => m.status === 'open');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ game: this.deps.getGame(), openMarkets, fees: this.deps.getFees() }));
      return;
    }
    if (url === '/fees') {
      // Treasury revenue snapshot: rake collected, where it goes, over how many markets.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.deps.getFees()));
      return;
    }
    res.writeHead(404).end();
  }
}

/** Structural validation of an incoming bet (the WS boundary trusts nothing). */
function isValidBet(msg: Extract<ClientMessage, { t: 'bet' }>): boolean {
  return (
    typeof msg.marketId === 'string' &&
    (msg.side === 'YES' || msg.side === 'NO') &&
    typeof msg.stake === 'number' &&
    Number.isFinite(msg.stake) &&
    msg.stake > 0 &&
    typeof msg.userId === 'string' &&
    msg.userId.length > 0
  );
}

/** Every room_* ClientMessage variant (what handleRoomMessage dispatches). */
type RoomClientMessage = Extract<ClientMessage, { t: `room_${string}` }>;

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Coerce an untrusted name/question to a string; the manager trims + caps it. */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isValidRoomBet(msg: Extract<ClientMessage, { t: 'room_bet' }>): boolean {
  return (
    isNonEmptyStr(msg.code) &&
    isNonEmptyStr(msg.userId) &&
    isNonEmptyStr(msg.marketId) &&
    (msg.side === 'YES' || msg.side === 'NO') &&
    typeof msg.stake === 'number' &&
    Number.isFinite(msg.stake) &&
    msg.stake > 0
  );
}

function isValidRoomResolve(msg: Extract<ClientMessage, { t: 'room_resolve_market' }>): boolean {
  return (
    isNonEmptyStr(msg.code) &&
    isNonEmptyStr(msg.userId) &&
    isNonEmptyStr(msg.marketId) &&
    (msg.outcome === 'YES' || msg.outcome === 'NO' || msg.outcome === 'VOID')
  );
}
