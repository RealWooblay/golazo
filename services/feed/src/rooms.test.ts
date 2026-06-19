import { describe, it, expect, beforeEach } from 'vitest';
import { ROOM_RAKE, ROOM_START_BALANCE, type Market, type ServerMessage } from '@golazo/core';

/** Parimutuel net for the SOLE winner of a pool (takes the whole pool minus the room fee). */
const soleWinnerNet = (stake: number, poolTotal: number) =>
  -stake + poolTotal * (1 - ROOM_RAKE);
import { RoomManager } from './rooms';

/** Capture everything the manager emits via its broadcastRoom sink. */
function makeManager(opts: { live?: boolean } = {}) {
  const emitted: Array<{ code: string; msg: ServerMessage }> = [];
  let t = 1_000;
  // Deterministic RNG: a steadily-increasing fraction → distinct room codes.
  let r = 0;
  const mgr = new RoomManager({
    emit: (code, msg) => emitted.push({ code, msg }),
    matchId: () => 'sim-arg-fra',
    isLive: () => opts.live ?? true,
    now: () => t,
    rand: () => {
      r = (r + 0.137) % 1;
      return r;
    },
  });
  return {
    mgr,
    emitted,
    advance: (ms: number) => {
      t += ms;
    },
    setTime: (v: number) => {
      t = v;
    },
  };
}

/** Minimal global Market for relay-hook tests. */
function globalMarket(over: Partial<Market> = {}): Market {
  return {
    id: 'mkt_1',
    gameId: 'sim-arg-fra',
    question: 'Argentina on the attack — GOAL?',
    kind: 'goal_from_open_play',
    team: 'home',
    trueProb: 0.4,
    status: 'open',
    pool: { yes: 0, no: 0 },
    seedAmount: 0,
    bets: [],
    openedAt: 1_000,
    windowMs: 8_000,
    lockAt: 9_000,
    ...over,
  };
}

/** A settled-YES global Market (the relay resolves rooms with this outcome). */
function resolvedGlobal(outcome: 'YES' | 'NO' | 'VOID'): Market {
  return globalMarket({
    status: 'resolved',
    settlement: { outcome } as Market['settlement'],
  });
}

describe('RoomManager — lifecycle', () => {
  let h: ReturnType<typeof makeManager>;
  beforeEach(() => {
    h = makeManager();
  });

  it('creates a room with a host starting at ROOM_START_BALANCE, phase live', () => {
    const fx = h.mgr.createRoom('u1', 'Alice');
    expect(fx.state).toBeDefined();
    const s = fx.state!;
    expect(s.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(s.hostId).toBe('u1');
    expect(s.phase).toBe('live');
    expect(s.players).toHaveLength(1);
    expect(s.players[0]).toMatchObject({
      userId: 'u1',
      name: 'Alice',
      balance: ROOM_START_BALANCE,
      isHost: true,
      connected: true,
    });
  });

  it('a room created while the feed is idle is in lobby', () => {
    const idle = makeManager({ live: false });
    expect(idle.mgr.createRoom('u1', 'A').state!.phase).toBe('lobby');
  });

  it('lets friends join; errors on a bad code and when full', () => {
    const code = h.mgr.createRoom('u1', 'Alice').state!.code;
    const join = h.mgr.joinRoom(code, 'u2', 'Bob');
    expect(join.state!.players).toHaveLength(2);
    expect(join.state!.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE);

    expect(h.mgr.joinRoom('ZZZZ', 'u3', 'X').error).toBeDefined();

    // Fill the room to its cap (host + joiners = 8), then the next join errors.
    for (let i = 3; i <= 8; i++) h.mgr.joinRoom(code, `u${i}`, `P${i}`);
    expect(h.mgr.getRoomState(code)!.players).toHaveLength(8);
    expect(h.mgr.joinRoom(code, 'u9', 'Late').error?.message).toMatch(/full/i);
  });

  it('join is idempotent for the same userId (reconnect marks connected)', () => {
    const code = h.mgr.createRoom('u1', 'Alice').state!.code;
    h.mgr.joinRoom(code, 'u2', 'Bob');
    h.mgr.disconnect(code, 'u2');
    expect(h.mgr.getRoomState(code)!.players.find((p) => p.userId === 'u2')!.connected).toBe(false);
    const re = h.mgr.joinRoom(code, 'u2', 'Bob');
    expect(re.state!.players).toHaveLength(2);
    expect(re.state!.players.find((p) => p.userId === 'u2')!.connected).toBe(true);
  });

  it('accepts a lowercase / padded code (normalized on lookup)', () => {
    const code = h.mgr.createRoom('u1', 'Alice').state!.code;
    expect(h.mgr.joinRoom(`  ${code.toLowerCase()} `, 'u2', 'Bob').state!.players).toHaveLength(2);
  });

  it('drops the room when the last connected socket disconnects', () => {
    const code = h.mgr.createRoom('u1', 'Alice').state!.code;
    h.mgr.disconnect(code, 'u1');
    expect(h.mgr.has(code)).toBe(false);
  });

  it('reassigns host when the host leaves', () => {
    const code = h.mgr.createRoom('u1', 'Alice').state!.code;
    h.mgr.joinRoom(code, 'u2', 'Bob');
    const fx = h.mgr.leave(code, 'u1');
    expect(fx.state!.hostId).toBe('u2');
    expect(fx.state!.players.find((p) => p.userId === 'u2')!.isHost).toBe(true);
  });
});

describe('RoomManager — friend markets + parimutuel betting', () => {
  let h: ReturnType<typeof makeManager>;
  let code: string;
  beforeEach(() => {
    h = makeManager();
    code = h.mgr.createRoom('u1', 'Alice').state!.code;
    h.mgr.joinRoom(code, 'u2', 'Bob');
  });

  /** Helper: open a friend market and return its id. */
  function openFriendMarket(author: string, q = 'GOAL?', team?: 'home' | 'away'): string {
    const fx = h.mgr.makeMarket(code, author, q, team);
    const open = fx.markets.find((m) => m.t === 'room_market_open');
    expect(open).toBeDefined();
    return (open as Extract<ServerMessage, { t: 'room_market_open' }>).market.id;
  }

  it('opens a friend market with an empty pool and status open', () => {
    const marketId = openFriendMarket('u1', 'Corner cleared?', 'home');
    const mkt = h.mgr.getRoomState(code)!.markets.at(-1)!;
    expect(mkt.id).toBe(marketId);
    expect(mkt.source).toBe('friend');
    expect(mkt.authorId).toBe('u1');
    expect(mkt.pool).toEqual({ yes: 0, no: 0 });
    expect(mkt.status).toBe('open');
    expect(mkt.bets).toHaveLength(0);
  });

  it('debits balance and grows the pool on a bet; one bet per market per player', () => {
    const marketId = openFriendMarket('u1');

    const fx = h.mgr.placeBet(code, 'u2', marketId, 'YES', 100);
    const bob = fx.state!.players.find((p) => p.userId === 'u2')!;
    expect(bob.balance).toBe(ROOM_START_BALANCE - 100);

    const mkt = fx.state!.markets.at(-1)!;
    expect(mkt.pool).toEqual({ yes: 100, no: 0 });
    expect(mkt.bets).toEqual([{ userId: 'u2', side: 'YES', stake: 100 }]);
    expect(fx.markets.some((x) => x.t === 'room_market_update')).toBe(true);

    // Second bet by the same player is rejected (pool unchanged).
    expect(h.mgr.placeBet(code, 'u2', marketId, 'NO', 50).error?.message).toMatch(/already bet/i);
    expect(h.mgr.getRoomState(code)!.markets.at(-1)!.pool).toEqual({ yes: 100, no: 0 });
  });

  it('rejects an over-stake and a stake after the window closes', () => {
    const marketId = openFriendMarket('u1');
    expect(
      h.mgr.placeBet(code, 'u2', marketId, 'YES', ROOM_START_BALANCE + 1).error?.message,
    ).toMatch(/balance/i);
    h.advance(FRIEND_MARKET_WINDOW_PAST);
    expect(h.mgr.placeBet(code, 'u2', marketId, 'YES', 10).error?.message).toMatch(/window/i);
  });

  it('head-to-head resolve: Alice YES 100 + Bob NO 100, resolve YES → Alice +100 net, Bob −100', () => {
    const marketId = openFriendMarket('u1');
    h.mgr.placeBet(code, 'u1', marketId, 'YES', 100);
    h.mgr.placeBet(code, 'u2', marketId, 'NO', 100);

    // Mid-market: both debited, pool holds the whole stack.
    const mid = h.mgr.getRoomState(code)!;
    expect(mid.players.find((p) => p.userId === 'u1')!.balance).toBe(ROOM_START_BALANCE - 100);
    expect(mid.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE - 100);
    expect(mid.markets.at(-1)!.pool).toEqual({ yes: 100, no: 100 });

    const fx = h.mgr.resolveMarket(code, 'u1', marketId, 'YES');
    const alice = fx.state!.players.find((p) => p.userId === 'u1')!;
    const bob = fx.state!.players.find((p) => p.userId === 'u2')!;
    // Alice wins the $200 pool minus the small room fee: −100 staked + payout.
    expect(alice.balance).toBeCloseTo(ROOM_START_BALANCE + soleWinnerNet(100, 200), 6);
    // Bob's $100 stake funded her: net −100.
    expect(bob.balance).toBe(ROOM_START_BALANCE - 100);
    expect(fx.state!.markets.at(-1)!.status).toBe('resolved');
    expect(fx.state!.markets.at(-1)!.outcome).toBe('YES');
    expect(fx.markets.some((x) => x.t === 'room_market_resolve')).toBe(true);
  });

  it('uneven parimutuel split: two YES backers share the losing NO stake by share', () => {
    // Alice YES 100, Bob YES 300 (pool yes=400), and a friend-market NO side
    // funded by author re-using... use AI relay for a 3-bettor scenario instead.
    // Here keep it 2-player: Alice YES 100, Bob NO 300 → resolve YES.
    const marketId = openFriendMarket('u1');
    h.mgr.placeBet(code, 'u1', marketId, 'YES', 100);
    h.mgr.placeBet(code, 'u2', marketId, 'NO', 300);

    const fx = h.mgr.resolveMarket(code, 'u1', marketId, 'YES');
    const alice = fx.state!.players.find((p) => p.userId === 'u1')!;
    const bob = fx.state!.players.find((p) => p.userId === 'u2')!;
    // Alice is the only YES → she takes the $400 pool minus the room fee.
    expect(alice.balance).toBeCloseTo(ROOM_START_BALANCE + soleWinnerNet(100, 400), 6);
    expect(bob.balance).toBe(ROOM_START_BALANCE - 300);
  });

  it('one-sided market refunds: both bet YES, resolve NO → both refunded (void)', () => {
    const marketId = openFriendMarket('u1');
    h.mgr.placeBet(code, 'u1', marketId, 'YES', 200);
    h.mgr.placeBet(code, 'u2', marketId, 'YES', 50);

    const fx = h.mgr.resolveMarket(code, 'u1', marketId, 'NO');
    // NO side had no stake → settleRoomMarket downgrades to a refund.
    expect(fx.state!.players.find((p) => p.userId === 'u1')!.balance).toBe(ROOM_START_BALANCE);
    expect(fx.state!.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE);
    expect(fx.state!.markets.at(-1)!.status).toBe('void');
    expect(fx.state!.markets.at(-1)!.outcome).toBe('VOID');
  });

  it('VOID refunds every stake', () => {
    const marketId = openFriendMarket('u1');
    h.mgr.placeBet(code, 'u1', marketId, 'YES', 200);
    h.mgr.placeBet(code, 'u2', marketId, 'NO', 75);
    const fx = h.mgr.resolveMarket(code, 'u1', marketId, 'VOID');
    expect(fx.state!.players.find((p) => p.userId === 'u1')!.balance).toBe(ROOM_START_BALANCE);
    expect(fx.state!.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE);
    expect(fx.state!.markets.at(-1)!.status).toBe('void');
  });

  it('only the host or author may resolve a friend market', () => {
    // u2 authors; the author can resolve.
    const m1 = openFriendMarket('u2');
    expect(h.mgr.resolveMarket(code, 'u2', m1, 'YES').state).toBeDefined();
    // Host (u1) can resolve a different market authored by u2 too.
    const m2 = openFriendMarket('u2', 'AGAIN?');
    expect(h.mgr.resolveMarket(code, 'u1', m2, 'NO').state).toBeDefined();
  });

  it('cannot resolve an AI market by hand (resolves automatically)', () => {
    h.mgr.onGlobalMarketOpen(globalMarket());
    const aiId = h.mgr.getRoomState(code)!.markets.at(-1)!.id;
    expect(h.mgr.resolveMarket(code, 'u1', aiId, 'YES').error?.message).toMatch(/automatically/i);
  });
});

describe('RoomManager — AI relay (lockstep with the global market)', () => {
  it('mirrors a global market into every room as an empty-pool AI market', () => {
    const h = makeManager();
    const codeA = h.mgr.createRoom('u1', 'A').state!.code;
    const codeB = h.mgr.createRoom('u3', 'C').state!.code;

    h.mgr.onGlobalMarketOpen(globalMarket());

    for (const c of [codeA, codeB]) {
      const mkt = h.mgr.getRoomState(c)!.markets.at(-1)!;
      expect(mkt.source).toBe('ai');
      expect(mkt.sourceMarketId).toBe('mkt_1');
      expect(mkt.pool).toEqual({ yes: 0, no: 0 });
      expect(mkt.question).toBe('Argentina on the attack — GOAL?');
      expect(mkt.team).toBe('home');
      expect(mkt.lockAt).toBe(9_000);
      expect(mkt.windowMs).toBe(8_000);
      expect(mkt.status).toBe('open');
    }
    // Each room got a room_market_open emit.
    expect(h.emitted.filter((e) => e.msg.t === 'room_market_open')).toHaveLength(2);
  });

  it('is idempotent — re-opening the same global id does not duplicate', () => {
    const h = makeManager();
    const code = h.mgr.createRoom('u1', 'A').state!.code;
    h.mgr.onGlobalMarketOpen(globalMarket());
    h.mgr.onGlobalMarketOpen(globalMarket());
    expect(
      h.mgr.getRoomState(code)!.markets.filter((m) => m.sourceMarketId === 'mkt_1'),
    ).toHaveLength(1);
  });

  it('locks then resolves the mirrored market parimutuel and credits balances', () => {
    const h = makeManager();
    const code = h.mgr.createRoom('u1', 'A').state!.code;
    h.mgr.joinRoom(code, 'u2', 'B');
    h.mgr.onGlobalMarketOpen(globalMarket());
    const marketId = h.mgr.getRoomState(code)!.markets.at(-1)!.id;

    // Head-to-head on the AI market: Alice YES 100, Bob NO 100.
    h.mgr.placeBet(code, 'u1', marketId, 'YES', 100);
    h.mgr.placeBet(code, 'u2', marketId, 'NO', 100);

    h.mgr.onGlobalMarketLock('mkt_1');
    expect(h.mgr.getRoomState(code)!.markets.at(-1)!.status).toBe('locked');

    h.mgr.onGlobalMarketResolve(resolvedGlobal('YES'));
    const s = h.mgr.getRoomState(code)!;
    expect(s.markets.at(-1)!.status).toBe('resolved');
    expect(s.markets.at(-1)!.outcome).toBe('YES');
    // Alice took the $200 pool minus the small room fee; Bob net −100.
    expect(s.players.find((p) => p.userId === 'u1')!.balance).toBeCloseTo(ROOM_START_BALANCE + soleWinnerNet(100, 200), 6);
    expect(s.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE - 100);
  });

  it('one-sided AI market refunds when the winning side has no stake', () => {
    const h = makeManager();
    const code = h.mgr.createRoom('u1', 'A').state!.code;
    h.mgr.joinRoom(code, 'u2', 'B');
    h.mgr.onGlobalMarketOpen(globalMarket());
    const marketId = h.mgr.getRoomState(code)!.markets.at(-1)!.id;

    h.mgr.placeBet(code, 'u1', marketId, 'NO', 100);
    h.mgr.placeBet(code, 'u2', marketId, 'NO', 200);

    h.mgr.onGlobalMarketResolve(resolvedGlobal('YES')); // YES had no stake
    const s = h.mgr.getRoomState(code)!;
    expect(s.markets.at(-1)!.status).toBe('void');
    expect(s.players.find((p) => p.userId === 'u1')!.balance).toBe(ROOM_START_BALANCE);
    expect(s.players.find((p) => p.userId === 'u2')!.balance).toBe(ROOM_START_BALANCE);
  });

  it('does nothing on resolve without a settled outcome', () => {
    const h = makeManager();
    const code = h.mgr.createRoom('u1', 'A').state!.code;
    h.mgr.onGlobalMarketOpen(globalMarket());
    h.mgr.onGlobalMarketResolve(globalMarket()); // no settlement
    expect(h.mgr.getRoomState(code)!.markets.at(-1)!.status).toBe('open');
  });
});

// 1ms past a default friend window.
const FRIEND_MARKET_WINDOW_PAST = 30_000 + 1;
