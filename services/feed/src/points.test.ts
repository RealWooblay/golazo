import { describe, expect, it } from 'vitest';
import { HOUSE_SEED_POINTS, PointsManager } from './points';
import type { Market } from '@golazo/core';
import { POINTS_START_BALANCE } from '@golazo/core';

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

describe('PointsManager', () => {
  it('registers a player with starting balance', () => {
    const pm = new PointsManager();
    const fx = pm.register('u1', 'Alice');
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
    expect(fx.leaderboard?.[0]!.name).toBe('Alice');
  });

  it('places bets into a separate pool and settles winners', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.register('u2', 'Bob');
    const m = fakeMarket('m1');
    pm.onMarketOpen(m);

    pm.placeBet('u1', 'm1', 'YES', 500);
    pm.placeBet('u2', 'm1', 'NO', 500);

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
    const alice = fx.leaderboard?.find((p) => p.userId === 'u1');
    const bob = fx.leaderboard?.find((p) => p.userId === 'u2');
    expect(alice!.balance).toBeGreaterThan(POINTS_START_BALANCE - 500);
    expect(bob!.balance).toBe(POINTS_START_BALANCE - 500);
  });

  it('pays a SOLO winner MORE than their stake out of house liquidity', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1')); // trueProb 0.5 → seeded 75/75
    pm.placeBet('u1', 'm1', 'NO', 100); // the ONLY human bet — no opponent

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

    // Won NO with nobody on the other side — paid from the house's YES seed, so the
    // balance lands ABOVE the starting balance (real winnings, not a bare refund,
    // which is exactly the "I only got my points back" bug).
    expect(pm.leaderboard()[0]!.balance).toBeGreaterThan(POINTS_START_BALANCE);
  });

  it('rejects when balance is insufficient', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    const fx = pm.placeBet('u1', 'm1', 'YES', POINTS_START_BALANCE + 1);
    expect(fx.rejected?.reason).toMatch(/not enough/i);
  });

  it('refills low paper-trade balance', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.placeBet('u1', 'm1', 'YES', POINTS_START_BALANCE - 10);
    const fx = pm.refill('u1');
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
  });

  it('holds stake during bet delay then confirms into the pool', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));

    const hold = pm.holdBet('u1', 'm1', 'YES', 100);
    expect(hold.state?.balance).toBe(POINTS_START_BALANCE - 100);
    expect(hold.marketUpdate).toBeUndefined();

    const confirm = pm.confirmHeldBet('u1', 'm1');
    expect(confirm.marketUpdate?.poolYes).toBe(HOUSE_SEED_POINTS / 2 + 100); // house seed + stake
    expect(confirm.state?.balance).toBe(POINTS_START_BALANCE - 100);
  });

  it('refunds a held stake when the bet is released', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.holdBet('u1', 'm1', 'NO', 80);
    const fx = pm.releaseHeldBet('u1', 'm1', 'play resolved before your bet cleared');
    expect(fx.rejected?.stake).toBe(80);
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE);
  });

  it('confirms a held bet after the market locks', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    const m = fakeMarket('m1');
    pm.onMarketOpen(m);
    pm.holdBet('u1', 'm1', 'YES', 100);
    pm.onMarketLock('m1');
    const fx = pm.confirmHeldBet('u1', 'm1');
    expect(fx.marketUpdate?.poolYes).toBe(HOUSE_SEED_POINTS / 2 + 100); // house seed + stake
    expect(fx.state?.balance).toBe(POINTS_START_BALANCE - 100);
  });

  it('refunds held stake when the market resolves before confirm', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.holdBet('u1', 'm1', 'YES', 60);
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
    const fx = pm.confirmHeldBet('u1', 'm1');
    expect(fx.rejected?.reason).toMatch(/resolved/i);
    expect(pm.leaderboard()[0]!.balance).toBe(POINTS_START_BALANCE);
  });

  it('allows concurrent holds on different markets', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    pm.onMarketOpen(fakeMarket('m1'));
    pm.onMarketOpen(fakeMarket('m2'));

    pm.holdBet('u1', 'm1', 'YES', 100);
    const hold2 = pm.holdBet('u1', 'm2', 'NO', 100);
    expect(hold2.state?.balance).toBe(POINTS_START_BALANCE - 200);

    pm.confirmHeldBet('u1', 'm1');
    const confirm2 = pm.confirmHeldBet('u1', 'm2');
    expect(confirm2.marketUpdate?.poolNo).toBe(HOUSE_SEED_POINTS / 2 + 100); // house seed + stake
  });

  it('moves cross-mode points on a settled REAL bet (win + loss)', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice'); // a real-mode bettor who joined the points system
    pm.register('u2', 'Bob');
    const m = fakeMarket('m1', 'resolved');
    // Real settlement: Alice won (+150 net over her 100 stake), Bob lost his 80.
    m.settlement = {
      outcome: 'YES',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [
        { userId: 'u1', side: 'YES', stake: 100, payout: 250, won: true },
        { userId: 'u2', side: 'NO', stake: 80, payout: 0, won: false },
        { userId: 'bot7', side: 'NO', stake: 40, payout: 0, won: false },
      ],
    };
    const fx = pm.awardRealBet(m);
    expect(fx.settled?.length).toBe(2); // bot7 isn't a points player — skipped
    const alice = fx.leaderboard?.find((p) => p.userId === 'u1');
    const bob = fx.leaderboard?.find((p) => p.userId === 'u2');
    expect(alice!.balance).toBe(POINTS_START_BALANCE + 150); // +round(250-100)
    expect(bob!.balance).toBe(POINTS_START_BALANCE - 80); // burns on a loss too
  });

  it('does not move points on a VOID real market', () => {
    const pm = new PointsManager();
    pm.register('u1', 'Alice');
    const m = fakeMarket('m1', 'void');
    m.settlement = {
      outcome: 'VOID',
      rakeTaken: 0,
      distributable: 0,
      totalPayouts: 0,
      operatorPnl: 0,
      payouts: [{ userId: 'u1', side: 'YES', stake: 100, payout: 100, won: false }],
    };
    const fx = pm.awardRealBet(m);
    expect(fx.settled).toBeUndefined();
    expect(fx.leaderboard).toBeUndefined();
    expect(pm.leaderboard()[0]!.balance).toBe(POINTS_START_BALANCE);
  });
});
