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
import type { ClientMessage, ServerMessage, GameState, Market, MarketEngine, Side } from '@golazo/core';
import { RoomManager, type RoomEffects } from './rooms';
import { PointsManager, type PointsEffects } from './points';
import { canAcceptBetNow } from './betDelay';
import { handleRpcProxy } from './rpcProxy';
import { ReferralManager } from './referrals';

/** Callback the orchestrator supplies to handle an authenticated user bet. */
export type BetHandler = (msg: Extract<ClientMessage, { t: 'bet' }>) => void;

/** Callback the orchestrator supplies to handle a points-mode bet. */
export type PointsBetHandler = (msg: Extract<ClientMessage, { t: 'points_bet' }>) => void;

export interface FeeSnapshot {
  recipient: string;
  rakeBps: number;
  collected: number;
  marketsSettled: number;
}

import type { AuditEntry } from './observability/auditLog';
import type { MetricsSnapshot } from './observability/metrics';

export interface OpsSnapshot {
  feedKind: string;
  watcher: string;
  /** AI market-director state: 'off' | 'ai-direct(idle)' | 'ai-direct(N queued)'. */
  director?: string;
  metrics: MetricsSnapshot;
  audit: readonly AuditEntry[];
  playPhase: string;
}

export interface ServerDeps {
  port: number;
  engine: MarketEngine;
  /** Snapshot accessor for the current game state (for /state + hello replay). */
  getGame: () => GameState;
  /** Called when a client sends a valid `bet` message. */
  onBet: BetHandler;
  /** Called when a client sends a valid `points_bet` message. */
  onPointsBet: PointsBetHandler;
  /** Current treasury fee snapshot (for /state + /fees). */
  getFees: () => FeeSnapshot;
  /** Ops / observability snapshot for /health and /metrics. */
  getOps?: () => OpsSnapshot;
  /** Open/locked global AI markets for late room join backfill. */
  getOpenGlobalMarkets?: () => Market[];
  /** Anti-latency hold before room pool bets land (mirrors orchestrator bet delay). */
  betDelayMs?: number;
  /** Disk path for play-money points persistence (balances survive restarts). */
  pointsStorePath?: string;
  /** Disk path for referral code attribution + owed-partner ledger. */
  referralStorePath?: string;
  /** Partner share of referred volume, in bps. 100 = 1 percentage point. */
  referralPayoutBps?: number;
  /** Optional bearer token for referral admin writes. */
  referralAdminToken?: string;
  /** Upstream Solana JSON-RPC URL — proxied at POST /rpc (key stays server-side). */
  solanaRpcUrl?: string;
}

/** What socket belongs to which room/player (cleaned up on close). */
interface SocketRoom {
  code: string;
  userId: string;
}

interface SocketPoints {
  userId: string;
}

interface HeldRoomBet {
  code: string;
  userId: string;
  marketId: string;
  side: Side;
  stake: number;
  timer: ReturnType<typeof setTimeout>;
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
  /** Authoritative play-mode points + leaderboard (persisted across restarts). */
  readonly pointsManager: PointsManager;
  /** Referral code attribution + manual-payout ledger. */
  readonly referralManager: ReferralManager;

  /** Reverse index: points player on this socket (for targeted state on hello). */
  private readonly socketPoints = new WeakMap<WebSocket, SocketPoints>();

  /** Pending room bets held for bet-delay (key: code:userId:marketId). */
  private readonly roomBetHeld = new Map<string, HeldRoomBet>();

  constructor(private readonly deps: ServerDeps) {
    this.pointsManager = new PointsManager(deps.pointsStorePath);
    this.referralManager = new ReferralManager({
      storePath: deps.referralStorePath,
      rakeBps: Math.round(deps.engine.rake * 10_000),
      defaultPayoutBps: deps.referralPayoutBps ?? 100,
      asset: 'USX',
    });
    this.roomManager = new RoomManager({
      emit: (code, msg) => this.broadcastRoom(code, msg),
      matchId: () => this.deps.getGame().gameId,
      isLive: () => this.deps.getGame().status === 'live',
      isFinal: () => this.deps.getGame().status === 'final',
      getOpenGlobalMarkets: deps.getOpenGlobalMarkets,
    });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  /** Start listening. Resolves once the port is bound. */
  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(this.deps.port, () => resolve());
    });
  }

  clientCount(): number {
    return this.clients.size;
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

  /** Fan out play-mode side effects from the PointsManager. */
  emitPoints(effects: PointsEffects): void {
    if (effects.leaderboard) {
      this.broadcast({ t: 'points_leaderboard', players: effects.leaderboard });
    }
    if (effects.marketUpdate) {
      this.broadcast({ t: 'points_market_update', snapshot: effects.marketUpdate });
    }
    if (effects.rejected) {
      const r = effects.rejected;
      this.broadcast({
        t: 'points_bet_rejected',
        marketId: r.marketId,
        userId: r.userId,
        stake: r.stake,
        reason: r.reason,
      });
    }
    if (effects.refillRejected) {
      const r = effects.refillRejected;
      this.broadcast({
        t: 'points_refill_rejected',
        userId: r.userId,
        reason: r.reason,
      });
    }
    if (effects.settled) {
      for (const s of effects.settled) {
        this.broadcast({
          t: 'points_settle',
          marketId: s.marketId,
          userId: s.userId,
          payout: s.payout,
          outcome: s.outcome,
          balance: s.balance,
        });
      }
    }
    if (effects.state) {
      for (const ws of this.clients) {
        const reg = this.socketPoints.get(ws);
        if (reg?.userId === effects.state!.userId && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              t: 'points_state',
              userId: effects.state.userId,
              balance: effects.state.balance,
              rank: effects.state.rank,
            } satisfies ServerMessage),
          );
        }
      }
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
    this.replaySession(ws);

    ws.on('message', (raw) => this.handleClientMessage(ws, raw.toString()));
    ws.on('close', () => this.handleClose(ws));
    // Never let a socket-level error take down the process.
    ws.on('error', () => this.handleClose(ws));
  }

  /** Socket gone: drop it everywhere and mark its room player disconnected. */
  private handleClose(ws: WebSocket): void {
    this.clients.delete(ws);
    const pts = this.socketPoints.get(ws);
    if (pts) {
      this.socketPoints.delete(ws);
      const effects = this.pointsManager.disconnect(pts.userId);
      this.emitPoints(effects);
    }
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

  /** Push current game + all markets for this fixture so reconnects get full history. */
  private replaySession(ws: WebSocket): void {
    const game = this.deps.getGame();
    ws.send(JSON.stringify({ t: 'game', game } satisfies ServerMessage));

    const gameId = game.gameId;
    const markets = this.deps.engine
      .list()
      .filter((m) => m.gameId === gameId)
      .sort((a, b) => a.openedAt - b.openedAt);

    for (const m of markets) {
      if (m.status === 'open') {
        ws.send(JSON.stringify({ t: 'market_open', market: m } satisfies ServerMessage));
      } else if (m.status === 'locked') {
        ws.send(JSON.stringify({ t: 'market_open', market: m } satisfies ServerMessage));
        ws.send(JSON.stringify({ t: 'market_lock', market: m } satisfies ServerMessage));
      } else if (m.status === 'resolved' || m.status === 'void') {
        ws.send(JSON.stringify({ t: 'market_resolve', market: m } satisfies ServerMessage));
      }
    }
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
        this.replaySession(ws);
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
      case 'points_hello':
        if (!isValidPointsHello(msg)) return;
        this.socketPoints.set(ws, { userId: msg.userId });
        {
          const effects = this.pointsManager.register(
            msg.userId,
            msg.name,
            typeof msg.priorUserId === 'string' ? msg.priorUserId : undefined,
          );
          const gameId = this.deps.getGame().gameId;
          for (const m of this.deps.engine.list()) {
            if (m.gameId !== gameId) continue;
            const snap = this.pointsManager.syncMarket(m);
            if (snap) {
              ws.send(
                JSON.stringify({
                  t: 'points_market_update',
                  snapshot: snap,
                } satisfies ServerMessage),
              );
            }
          }
          this.emitPoints(effects);
        }
        return;
      case 'points_bet':
        if (!isValidPointsBet(msg)) return;
        try {
          this.deps.onPointsBet(msg);
        } catch {
          /* ignore bad input */
        }
        return;
      case 'points_refill':
        if (!isValidPointsRefill(msg)) return;
        this.emitPoints(this.pointsManager.refill(msg.userId));
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
        this.handleRoomBet(ws, msg);
        return;
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

  /**
   * Room pool bet with the same anti-latency hold as public/points bets. Chain
   * stakes land on Solana first; this records the parimutuel pool after the hold.
   */
  private handleRoomBet(
    ws: WebSocket,
    msg: Extract<ClientMessage, { t: 'room_bet' }>,
  ): void {
    const code = msg.code.trim().toUpperCase();
    const state = this.roomManager.getRoomState(code);
    const market = state?.markets.find((m) => m.id === msg.marketId);
    if (!canAcceptBetNow(market, Date.now())) {
      this.sendRoomError(ws, code, 'market not open');
      return;
    }

    const key = this.heldRoomKey(code, msg.userId, msg.marketId);
    if (this.roomBetHeld.has(key)) return;

    const accept = () => {
      this.roomBetHeld.delete(key);
      const fresh = this.roomManager.getRoomState(code);
      const m = fresh?.markets.find((x) => x.id === msg.marketId);
      if (!canAcceptBetNow(m, Date.now())) {
        this.sendRoomError(ws, code, 'play resolved before your bet cleared');
        return;
      }
      const effects = this.roomManager.placeBet(
        code,
        msg.userId,
        msg.marketId,
        msg.side,
        msg.stake,
      );
      this.dispatchRoomEffects(ws, effects);
    };

    const delay = this.deps.betDelayMs ?? 0;
    if (delay <= 0) {
      accept();
      return;
    }
    const timer = setTimeout(accept, delay);
    this.roomBetHeld.set(key, {
      code,
      userId: msg.userId,
      marketId: msg.marketId,
      side: msg.side,
      stake: msg.stake,
      timer,
    });
  }

  private heldRoomKey(code: string, userId: string, marketId: string): string {
    return `${code}:${userId}:${marketId}`;
  }

  private sendRoomError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'room_error', code, message } satisfies ServerMessage));
    }
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

  /** GET /health, GET /state, POST /rpc (Solana proxy); everything else is 404. */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (path === '/referrals' || path.startsWith('/referrals/')) {
      void this.handleReferralHttp(req, res);
      return;
    }

    if (path === '/rpc' || path === '/rpc/') {
      const upstream = this.deps.solanaRpcUrl?.trim();
      if (!upstream) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rpc proxy not configured' }));
        return;
      }
      void handleRpcProxy(req, res, upstream);
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url === '/health' || url.startsWith('/health?')) {
      const ops = this.deps.getOps?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          clients: this.clients.size,
          feed: ops?.feedKind ?? 'unknown',
          watcher: ops?.watcher ?? 'unknown',
          director: ops?.director ?? 'off',
          playPhase: ops?.playPhase ?? 'unknown',
          lastPollAgeMs: ops?.metrics.lastPollAgeMs ?? null,
          marketsOpen: this.deps.engine.list().filter((m) => m.status === 'open').length,
        }),
      );
      return;
    }
    if (url === '/metrics') {
      const ops = this.deps.getOps?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ops?.metrics ?? { ok: false }));
      return;
    }
    if (url === '/audit' || url.startsWith('/audit?')) {
      const ops = this.deps.getOps?.();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entries: ops?.audit ?? [] }));
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

  private async handleReferralHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, referralHeaders());
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && path === '/referrals/estimate') {
        const volume = Number(url.searchParams.get('volume') ?? '0');
        const code = url.searchParams.get('code') ?? undefined;
        this.sendReferralJson(res, 200, this.referralManager.estimate(volume, code));
        return;
      }

      if (req.method === 'GET' && path === '/referrals/summary') {
        const code = url.searchParams.get('code') ?? undefined;
        const ownerId = url.searchParams.get('ownerId') ?? undefined;
        this.sendReferralJson(res, 200, this.referralManager.summary({ code, ownerId }));
        return;
      }

      if (req.method === 'GET' && path === '/referrals/attribution') {
        const userId = url.searchParams.get('userId')?.trim() ?? '';
        this.sendReferralJson(res, 200, {
          attribution: userId ? (this.referralManager.attributionFor(userId) ?? null) : null,
        });
        return;
      }

      if (req.method === 'GET' && path === '/referrals/profile') {
        const userId = url.searchParams.get('userId')?.trim() ?? '';
        if (!userId) {
          this.sendReferralJson(res, 400, { error: 'userId required' });
          return;
        }
        this.sendReferralJson(res, 200, this.referralManager.profile(userId));
        return;
      }

      if (req.method === 'GET' && path === '/referrals/codes') {
        if (!this.referralAdminAllowed(req)) {
          this.sendReferralJson(res, 401, { error: 'unauthorized' });
          return;
        }
        this.sendReferralJson(res, 200, {
          codes: this.referralManager.snapshot().codes,
        });
        return;
      }

      if (req.method === 'POST' && path === '/referrals/attribute') {
        const body = await readJsonBody(req);
        const o = isObject(body) ? body : {};
        const result = this.referralManager.attribute({
          userId: typeof o.userId === 'string' ? o.userId : '',
          code: typeof o.code === 'string' ? o.code : '',
          source: typeof o.source === 'string' ? o.source : undefined,
        });
        this.sendReferralJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && path === '/referrals/codes') {
        if (!this.referralAdminAllowed(req)) {
          this.sendReferralJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJsonBody(req);
        const o = isObject(body) ? body : {};
        const code = this.referralManager.createCode({
          code: typeof o.code === 'string' ? o.code : undefined,
          ownerId: typeof o.ownerId === 'string' ? o.ownerId : '',
          ownerLabel: typeof o.ownerLabel === 'string' ? o.ownerLabel : undefined,
          payoutBps: typeof o.payoutBps === 'number' ? o.payoutBps : undefined,
        });
        this.sendReferralJson(res, 201, code);
        return;
      }

      if (req.method === 'POST' && path === '/referrals/payout') {
        if (!this.referralAdminAllowed(req)) {
          this.sendReferralJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJsonBody(req);
        const o = isObject(body) ? body : {};
        const result = this.referralManager.markPaid({
          code: typeof o.code === 'string' ? o.code : undefined,
          ownerId: typeof o.ownerId === 'string' ? o.ownerId : undefined,
          payoutTx: typeof o.payoutTx === 'string' ? o.payoutTx : undefined,
        });
        this.sendReferralJson(res, 200, result);
        return;
      }

      this.sendReferralJson(res, 404, { error: 'not found' });
    } catch (err) {
      this.sendReferralJson(res, 400, { error: (err as Error).message });
    }
  }

  private referralAdminAllowed(req: IncomingMessage): boolean {
    const token = this.deps.referralAdminToken;
    if (!token) return false;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${token}`;
  }

  private sendReferralJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, referralHeaders());
    res.end(JSON.stringify(body));
  }
}

function referralHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > 64_000) throw new Error('body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
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

function isValidPointsHello(msg: Extract<ClientMessage, { t: 'points_hello' }>): boolean {
  return isNonEmptyStr(msg.userId);
}

function isValidPointsBet(msg: Extract<ClientMessage, { t: 'points_bet' }>): boolean {
  return (
    typeof msg.marketId === 'string' &&
    (msg.side === 'YES' || msg.side === 'NO') &&
    typeof msg.stake === 'number' &&
    Number.isFinite(msg.stake) &&
    msg.stake > 0 &&
    isNonEmptyStr(msg.userId)
  );
}

function isValidPointsRefill(msg: Extract<ClientMessage, { t: 'points_refill' }>): boolean {
  return isNonEmptyStr(msg.userId);
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
