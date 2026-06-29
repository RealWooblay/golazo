import { describe, expect, it } from 'vitest';
import { PointsManager, safeDisplayName } from './points';
import type { Market } from '@golazo/core';
import { POINTS_START_BALANCE } from '@golazo/core';

describe('safeDisplayName — leaderboard must never doxx a user', () => {
  it('replaces an email with a stable anonymous handle', () => {
    const out = safeDisplayName('player@example.com', 'acct_did:privy:abcd1234');
    expect(out).not.toContain('@');
    expect(out).toBe('Player 1234');
  });
  it('catches a long email that would survive truncation', () => {
    expect(safeDisplayName('a-really-long-personal-email-address@example.com', 'acct_xZ9q')).toBe('Player XZ9Q');
  });
  it('replaces a phone number', () => {
    expect(safeDisplayName('+1 (415) 555-0199', 'acct_wallet9999')).toBe('Player 9999');
  });
  it('lets a real chosen handle through (trimmed, capped, hyphens/spaces kept)', () => {
    expect(safeDisplayName('  Goal-Machine 7  ', 'acct_x')).toBe('Goal-Machine 7');
    expect(safeDisplayName('x'.repeat(40), 'acct_x')).toHaveLength(24);
  });
  it('derives a handle for empty or bare "Player"', () => {
    expect(safeDisplayName('', 'acct_AAbb12cd')).toBe('Player 12CD');
    expect(safeDisplayName('player', 'acct_AAbb12cd')).toBe('Player 12CD');
  });
});

function fakeMarket(id: string, status: Market['status'] = 'open'): Market {
  const now = Date.now();
  return {
    id,
    gameId: 'g1',
    kind: 'attack',
    slot: 'moment',
    question: 'Test?',
    team: 'home',
    trueProb: 0.5,
    status,
    pool: { yes: 100, no: 50 },
    seedAmount: 0,
    bets: [],
    openedAt: now,
    lockAt: now + 30_000,
    windowMs: 10_000,
    resolveWindowMs: 60_000,
    resolveAt: now + 90_000,
  };
}

describe('PointsManager — public leaderboard carries no PII', () => {
  it('an email registered as a name never appears on the board', () => {
    const pm = new PointsManager();
    pm.register('acct_wallet_abcd', 'someone.real@privatemail.com');
    const me = pm.leaderboard().find((p) => p.userId === 'acct_wallet_abcd');
    expect(me).toBeTruthy();
    expect(me!.name).not.toContain('@');
    expect(me!.name).toBe('Player ABCD');
  });
});

describe('PointsManager', () => {
  it('registers a player with starting balance', () => {
    const pm = new PointsManager();
    const fx = pm.register('acct_u1', 'Alice');
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
    expect(fx.leaderboard?.[0]!.name).toBe('Alice');
  });

  it('merges a legacy pts_* session into acct_* on upgrade', () => {
    const pm = new PointsManager();
    const wallet = '11111111111111111111111111111112';
    pm.register('pts_device42', 'Guest');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.placeBet('pts_device42', 'm1', 'YES', 400);
    pm.register(`acct_${wallet}`, 'Alice', 'pts_device42');
    expect(pm.leaderboard().map((p) => p.userId)).toEqual([`acct_${wallet}`]);
    expect(pm.leaderboard()[0]?.balance).toBe(POINTS_START_BALANCE - 400);
  });

  it('merges a legacy acct_did into acct_wallet on upgrade', () => {
    const pm = new PointsManager();
    const wallet = '11111111111111111111111111111112';
    pm.register(`acct_did:privy:abc`, 'Ghost');
    pm.register(`acct_${wallet}`, 'Alice', `acct_did:privy:abc`);
    expect(pm.leaderboard().map((p) => p.userId)).toEqual([`acct_${wallet}`]);
  });

  it('leaderboard shows ONLY logged-in (acct_) players, never anonymous device users', () => {
    const pm = new PointsManager();
    pm.register('acct_alice', 'Alice'); // logged in
    pm.register('pts_device42', 'Guest'); // anonymous device session — can play, never ranked
    expect(pm.leaderboard().map((p) => p.userId)).toEqual(['acct_alice']);
    expect(pm.rankOf('pts_device42')).toBe(2); // off-board (board length + 1)
  });

  it('places bets into a separate pool and settles winners', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.register('acct_u2', 'Bob');
    const m = fakeMarket('m1');
    pm.onMarketOpen(m);

    pm.placeBet('acct_u1', 'm1', 'YES', 500);
    pm.placeBet('acct_u2', 'm1', 'NO', 500);

    const resolved = fakeMarket('m1', 'resolved');
    resolved.settlement = {
      outcome: 'YES',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [],
    };
    const fx = pm.onMarketResolve(resolved);
    expect(fx.settled?.length).toBe(2);
    const alice = fx.leaderboard?.find((p) => p.userId === 'acct_u1');
    const bob = fx.leaderboard?.find((p) => p.userId === 'acct_u2');
    expect(alice!.balance).toBeGreaterThan(POINTS_START_BALANCE - 500);
    expect(bob!.balance).toBe(POINTS_START_BALANCE - 500);
  });

  it('a SOLO bettor with no opponent only gets their stake back (no phantom house winnings)', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1')); // empty pool — no house seed
    pm.placeBet('acct_u1', 'm1', 'NO', 100); // the ONLY bet — nobody on the other side

    const resolved = fakeMarket('m1', 'resolved');
    resolved.settlement = {
      outcome: 'NO',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [],
    };
    pm.onMarketResolve(resolved);

    // Won NO, but with nobody on YES there's nothing to win FROM — pure parimutuel pays the
    // stake straight back (1.0x), no profit. (Had they been WRONG with no opponent, they'd
    // forfeit the whole stake — a one-sided loss is NOT a refund.)
    expect(pm.leaderboard()[0]!.balance).toBe(POINTS_START_BALANCE);
  });

  it('rejects when balance is insufficient', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    const fx = pm.placeBet('acct_u1', 'm1', 'YES', POINTS_START_BALANCE + 1);
    expect(fx.rejected?.reason).toMatch(/not enough/i);
  });

  it('refills low paper-trade balance', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.placeBet('acct_u1', 'm1', 'YES', POINTS_START_BALANCE - 10);
    const fx = pm.refill('acct_u1');
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
  });

  it('holds stake during bet delay then confirms into the pool', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));

    const hold = pm.holdBet('acct_u1', 'm1', 'YES', 100);
    expect(hold.state?.balance).toBe(POINTS_START_BALANCE - 100);
    expect(hold.marketUpdate).toBeUndefined();

    const confirm = pm.confirmHeldBet('acct_u1', 'm1');
    expect(confirm.marketUpdate?.poolYes).toBe(100); // pure stake — no house seed
    expect(confirm.state?.balance).toBe(POINTS_START_BALANCE - 100);
  });

  it('refunds a held stake when the bet is released', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.holdBet('acct_u1', 'm1', 'NO', 80);
    const fx = pm.releaseHeldBet('acct_u1', 'm1', 'play resolved before your bet cleared');
    expect(fx.rejected?.stake).toBe(80);
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
  });

  it('confirms a held bet after the market locks', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    const m = fakeMarket('m1');
    pm.onMarketOpen(m);
    pm.holdBet('acct_u1', 'm1', 'YES', 100);
    pm.onMarketLock('m1');
    const fx = pm.confirmHeldBet('acct_u1', 'm1');
    expect(fx.marketUpdate?.poolYes).toBe(100); // pure stake — no house seed
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE - 100);
  });

  it('refunds held stake when the market resolves before confirm', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.holdBet('acct_u1', 'm1', 'YES', 60);
    const resolved = fakeMarket('m1', 'resolved');
    resolved.settlement = {
      outcome: 'NO',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [],
    };
    pm.onMarketResolve(resolved);
    const fx = pm.confirmHeldBet('acct_u1', 'm1');
    expect(fx.rejected?.reason).toMatch(/resolved/i);
    expect(pm.leaderboard()[0]!.balance).toBe(POINTS_START_BALANCE);
  });

  it('allows concurrent holds on different markets', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.onMarketOpen(fakeMarket('m2'));

    pm.holdBet('acct_u1', 'm1', 'YES', 100);
    const hold2 = pm.holdBet('acct_u1', 'm2', 'NO', 100);
    expect(hold2.state?.balance).toBe(POINTS_START_BALANCE - 200);

    pm.confirmHeldBet('acct_u1', 'm1');
    const confirm2 = pm.confirmHeldBet('acct_u1', 'm2');
    expect(confirm2.marketUpdate?.poolNo).toBe(100); // pure stake — no house seed
  });

  it('moves cross-mode points on a settled REAL bet (win + loss)', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice'); // a real-mode bettor who joined the points system
    pm.register('acct_u2', 'Bob');
    const m = fakeMarket('m1', 'resolved');
    // Real settlement: Alice won (+150 net over her 100 stake), Bob lost his 80.
    m.settlement = {
      outcome: 'YES',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [
        { userId: 'acct_u1', side: 'YES', stake: 100, payout: 250, won: true },
        { userId: 'acct_u2', side: 'NO', stake: 80, payout: 0, won: false },
        { userId: 'bot7', side: 'NO', stake: 40, payout: 0, won: false },
      ],
    };
    const fx = pm.awardRealBet(m);
    expect(fx.settled?.length).toBe(2); // bot7 isn't a points player — skipped
    const alice = fx.leaderboard?.find((p) => p.userId === 'acct_u1');
    const bob = fx.leaderboard?.find((p) => p.userId === 'acct_u2');
    expect(alice!.balance).toBe(POINTS_START_BALANCE + 150); // +round(250-100)
    expect(bob!.balance).toBe(POINTS_START_BALANCE - 80); // burns on a loss too
  });

  it('does not move points on a VOID real market', () => {
    const pm = new PointsManager();
    pm.register('acct_u1', 'Alice');
    const m = fakeMarket('m1', 'void');
    m.settlement = {
      outcome: 'VOID',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [{ userId: 'acct_u1', side: 'YES', stake: 100, payout: 100, won: false }],
    };
    const fx = pm.awardRealBet(m);
    expect(fx.settled).toBeUndefined();
    expect(fx.leaderboard).toBeUndefined();
    expect(pm.leaderboard()[0]!.balance).toBe(POINTS_START_BALANCE);
  });
});
