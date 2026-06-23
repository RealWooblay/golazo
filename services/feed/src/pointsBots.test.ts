import { describe, expect, it, vi } from 'vitest';
import { PointsManager } from './points';
import { PointsBotSwarm, resolveBotConfig } from './bots';
import type { Market } from '@golazo/core';

function fakeMarket(id: string, trueProb = 0.5): Market {
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
    lockAt: now + 20_000,
    windowMs: 20_000,
    resolveWindowMs: 90_000,
    resolveAt: now + 110_000,
  } as unknown as Market;
}

/** Deterministic LCG so the swarm's randomness is stable across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('points house-liquidity bots (the ~1.1x fix)', () => {
  it('placeBotBet grows the pool with no balance check', () => {
    const pm = new PointsManager();
    pm.onMarketOpen(fakeMarket('m1')); // seed 75/75
    const fx = pm.placeBotBet('m1', 'YES', 40);
    expect(fx.marketUpdate?.poolYes).toBe(75 + 40);
    expect(pm.marketImpliedYes('m1')).toBeGreaterThan(0.5); // YES now heavier
  });

  it('fills BOTH sides and leaves a meaningful (not ~1.1x) multiple', () => {
    vi.useFakeTimers();
    try {
      const pm = new PointsManager();
      const m = fakeMarket('m2', 0.5);
      pm.onMarketOpen(m);

      const updates: { poolYes: number; poolNo: number }[] = [];
      const swarm = new PointsBotSwarm(
        pm,
        (fx) => fx.marketUpdate && updates.push(fx.marketUpdate),
        resolveBotConfig({ count: 16, minStake: 8, maxStake: 60, rng: lcg(7) }),
      );
      swarm.start(m);
      vi.advanceTimersByTime(20_000);

      expect(updates.length).toBeGreaterThan(8); // most bots fired + broadcast
      const last = updates[updates.length - 1]!;
      // Both sides got real bot money beyond the 75/75 seed.
      expect(last.poolYes).toBeGreaterThan(75);
      expect(last.poolNo).toBeGreaterThan(75);

      // A user's winning multiple on EITHER side is meaningful — not the pinned ~1.1x.
      const gross = last.poolYes + last.poolNo;
      const yesMult = gross / last.poolYes;
      const noMult = gross / last.poolNo;
      expect(Math.max(yesMult, noMult)).toBeGreaterThan(1.3);
      // The book is balanced toward trueProb (0.5), not lopsided.
      expect(pm.marketImpliedYes('m2')!).toBeGreaterThan(0.3);
      expect(pm.marketImpliedYes('m2')!).toBeLessThan(0.7);
    } finally {
      vi.useRealTimers();
    }
  });
});
