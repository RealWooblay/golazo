/**
 * Proof that the POINTS parimutuel behaves like the on-chain program: NO house seed,
 * NO bots — the multiple moves purely on REAL, AGGREGATED user money. Every user's stake
 * shifts the shared pool for everyone; money on EITHER side re-prices the other; and a
 * one-sided market settles VOID (refund) instead of paying a winner out of nothing.
 */
import { describe, expect, it } from 'vitest';
import { PointsManager } from './points';
import type { Market } from '@golazo/core';

function openMarket(id: string, trueProb = 0.5): Market {
  const now = Date.now();
  return {
    id,
    gameId: 'g1',
    kind: 'shot_in_window',
    slot: 'window',
    question: 'Shot?',
    team: 'home',
    trueProb,
    status: 'open',
    pool: { yes: 0, no: 0 },
    seedAmount: 0,
    bets: [],
    openedAt: now,
    lockAt: now + 60_000,
    windowMs: 60_000,
    resolveWindowMs: 90_000,
    resolveAt: now + 150_000,
  } as unknown as Market;
}

describe('points parimutuel: multiple moves on REAL aggregate user money (no seed, no bots)', () => {
  it('starts empty; the multiple is flat until BOTH sides are funded, then moves on every stake', () => {
    const pm = new PointsManager();
    pm.onMarketOpen(openMarket('m', 0.5));
    for (const u of ['amy', 'ben', 'cy', 'dan']) pm.register(u, u);
    const odds = (fx: { marketUpdate?: { oddsYes: number; oddsNo: number } }) => fx.marketUpdate!;

    // amy backs YES — with no opposing money there's nothing to win, so the multiple is flat (1.0).
    const a = pm.placeBet('amy', 'm', 'YES', 100);
    expect(a.marketUpdate!.poolYes).toBe(100); // pure user money — no seed
    expect(odds(a).oddsYes).toBeCloseTo(1.0, 6);

    // cy backs the OTHER side — NOW there's money to win: the multiple jumps off 1.0.
    const c = pm.placeBet('cy', 'm', 'NO', 100);
    expect(c.marketUpdate!.poolNo).toBe(100);
    expect(odds(c).oddsYes).toBeCloseTo(200 / 100, 6); // gross 200 / YES 100 = 2.0
    expect(odds(c).oddsYes).toBeGreaterThan(odds(a).oddsYes); // moved when money arrived on the other side

    // ben ALSO backs YES — the pool is the SUM of all users; more YES money lowers YES's own multiple.
    const b = pm.placeBet('ben', 'm', 'YES', 100);
    expect(b.marketUpdate!.poolYes).toBe(200); // amy + ben aggregated
    expect(b.marketUpdate!.participants).toBe(3);
    expect(odds(b).oddsYes).toBeCloseTo(300 / 200, 6); // 1.5 — fell as YES got heavier

    const d = pm.placeBet('dan', 'm', 'NO', 100);
    expect(d.marketUpdate!.participants).toBe(4); // exactly our 4 users — no bot bettors
    // The whole pool is ONLY real user stakes — no synthetic liquidity anywhere.
    expect(d.marketUpdate!.poolYes + d.marketUpdate!.poolNo).toBe(400);
  });

  it('settles parimutuel: winners split the whole pool by stake share; losers fund them', () => {
    const pm = new PointsManager();
    const market = openMarket('m2', 0.5);
    pm.onMarketOpen(market);
    for (const u of ['amy', 'ben', 'cy', 'dan']) pm.register(u, u);

    pm.placeBet('amy', 'm2', 'YES', 100);
    pm.placeBet('ben', 'm2', 'YES', 100);
    pm.placeBet('cy', 'm2', 'NO', 100);
    pm.placeBet('dan', 'm2', 'NO', 100);

    // gross 400, winning (YES) pool 200, rake 0 → winners split the full 400 by share.
    const resolved = pm.onMarketResolve({ ...market, settlement: { outcome: 'YES' } } as unknown as Market);
    const by = (id: string) => resolved.settled!.find((s) => s.userId === id)!;

    expect(by('amy').payout).toBeCloseTo((100 / 200) * 400, 4); // 200 — doubled their stake
    expect(by('ben').payout).toBeCloseTo((100 / 200) * 400, 4);
    expect(by('amy').balance).toBe(500 - 100 + 200); // 600
    expect(by('cy').payout).toBe(0);
    expect(by('cy').balance).toBe(400); // 500 − 100, nothing back
  });

  it('one-sided WIN VOIDs/refunds the stake (1.0x — nothing to win FROM)', () => {
    const pm = new PointsManager();
    const market = openMarket('m3', 0.5);
    pm.onMarketOpen(market);
    pm.register('amy', 'amy');
    pm.placeBet('amy', 'm3', 'YES', 100); // only YES is backed — no opponent

    const resolved = pm.onMarketResolve({ ...market, settlement: { outcome: 'YES' } } as unknown as Market);
    const amy = resolved.settled!.find((s) => s.userId === 'amy')!;
    expect(amy.outcome).toBe('VOID'); // no genuine two-way contest → void
    expect(amy.payout).toBe(100); // stake straight back, no profit
    expect(amy.balance).toBe(500);
  });

  it('one-sided LOSS also VOIDs/refunds — matches the on-chain isOneSidedRealBook void', () => {
    const pm = new PointsManager();
    const market = openMarket('m4', 0.5);
    pm.onMarketOpen(market);
    pm.register('amy', 'amy');
    pm.placeBet('amy', 'm4', 'YES', 100); // only YES is backed

    // No genuine opponent → REFUND, not forfeit. The on-chain operator voids/refunds a one-sided
    // real book; the off-chain settlement must agree so the app P&L + points + USX wallet match.
    const resolved = pm.onMarketResolve({ ...market, settlement: { outcome: 'NO' } } as unknown as Market);
    const amy = resolved.settled!.find((s) => s.userId === 'amy')!;
    expect(amy.outcome).toBe('VOID');
    expect(amy.payout).toBe(100); // refunded
    expect(amy.balance).toBe(500); // 500 − 100 staked + 100 refunded
  });
});
