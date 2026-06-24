/**
 * Points must SURVIVE a restart/redeploy — the fix for "I won, then my points reset".
 * A second PointsManager pointed at the same store reloads the persisted balances.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PointsManager } from './points';
import type { Market } from '@golazo/core';

const STORE = join(tmpdir(), `golazo-points-test-${process.pid}.json`);

function fakeMarket(id: string): Market {
  const now = Date.now();
  return {
    id, gameId: 'g1', kind: 'shot_in_window', slot: 'window', question: 'Shot?', team: 'home',
    trueProb: 0.5, status: 'open', pool: { yes: 0, no: 0 }, seedAmount: 0, bets: [],
    openedAt: now, lockAt: now + 60_000, windowMs: 60_000, resolveWindowMs: 90_000, resolveAt: now + 150_000,
  } as unknown as Market;
}

describe('points persistence (survives restart)', () => {
  afterEach(() => {
    try { rmSync(STORE); } catch { /* ignore */ }
  });

  it('reloads registered balances from disk', () => {
    const pm1 = new PointsManager(STORE);
    pm1.register('acct_u1', 'Alice');
    pm1.flush();

    const pm2 = new PointsManager(STORE); // "redeploy"
    expect(pm2.leaderboard().find((p) => p.userId === 'acct_u1')?.balance).toBe(500);
  });

  it('persists a WON balance across a restart (no reset to START)', () => {
    const pm1 = new PointsManager(STORE);
    pm1.register('acct_amy', 'acct_amy');
    pm1.register('acct_ben', 'acct_ben');
    const m = fakeMarket('m1');
    pm1.onMarketOpen(m);
    pm1.placeBet('acct_amy', 'm1', 'YES', 100);
    pm1.placeBet('acct_ben', 'm1', 'NO', 100);
    pm1.onMarketResolve({ ...m, settlement: { outcome: 'YES' } } as unknown as Market); // amy wins, flushes

    const amyBal = pm1.leaderboard().find((p) => p.userId === 'acct_amy')!.balance;
    expect(amyBal).toBe(600); // 500 − 100 stake + 200 payout

    const pm2 = new PointsManager(STORE); // "redeploy"
    expect(pm2.leaderboard().find((p) => p.userId === 'acct_amy')?.balance).toBe(600);
    expect(pm2.leaderboard().find((p) => p.userId === 'acct_ben')?.balance).toBe(400); // lost 100
  });

  it('is pure in-memory when no store path is given (tests/sims never touch disk)', () => {
    const pm = new PointsManager(); // no path
    pm.register('acct_u1', 'Alice');
    expect(() => pm.flush()).not.toThrow(); // no-op
  });
});
