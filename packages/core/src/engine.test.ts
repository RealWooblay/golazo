import { describe, it, expect } from 'vitest';
import { MarketEngine } from './engine';
import { triggerFromEvent } from './watcher';
import type { FeedEvent, MarketTrigger } from './types';

function trigger(over: Partial<MarketTrigger> = {}): MarketTrigger {
  return {
    gameId: 'g1',
    question: 'Argentina on the attack — GOAL?',
    kind: 'goal_from_open_play',
    team: 'home',
    windowMs: 6000,
    trueProb: 0.34,
    ...over,
  };
}

describe('MarketEngine lifecycle', () => {
  it('opens, seeds the pool by trueProb, and starts at sane odds', () => {
    const eng = new MarketEngine({ now: () => 1000 });
    const m = eng.openMarket(trigger({ trueProb: 0.25 }));
    expect(m.status).toBe('open');
    expect(m.seedAmount).toBe(0);
    expect(m.pool.yes).toBe(0);
    expect(m.pool.no).toBe(0);
    expect(eng.odds(m.id).prob).toBeCloseTo(0.5, 2);
    expect(m.lockAt).toBe(1000 + 6000);
  });

  it('accepts bets while open and rejects them once locked', () => {
    const eng = new MarketEngine();
    const m = eng.openMarket(trigger());
    const bet = eng.placeBet(m.id, 'user', 'YES', 25);
    expect(bet).toMatchObject({ userId: 'user', side: 'YES', stake: 25 });
    eng.lock(m.id);
    expect(() => eng.placeBet(m.id, 'user', 'YES', 25)).toThrow(/locked/);
  });

  it('a user YES win pays the final parimutuel share', () => {
    const eng = new MarketEngine();
    const m = eng.openMarket(trigger({ trueProb: 0.3 }));
    eng.placeBet(m.id, 'user', 'YES', 100);
    eng.placeBet(m.id, 'other', 'NO', 300);
    const s = eng.resolve(m.id, 'YES');
    const mine = s.payouts.find((p) => p.userId === 'user')!;
    expect(mine.won).toBe(true);
    expect(mine.payout).toBeCloseTo(376, 6);
  });

  it('emits lifecycle events', () => {
    const eng = new MarketEngine();
    const seen: string[] = [];
    eng.on('open', () => seen.push('open'));
    eng.on('update', () => seen.push('update'));
    eng.on('lock', () => seen.push('lock'));
    eng.on('resolve', () => seen.push('resolve'));
    const m = eng.openMarket(trigger());
    eng.placeBet(m.id, 'u', 'NO', 10);
    eng.resolve(m.id, 'NO');
    expect(seen).toEqual(['open', 'update', 'lock', 'resolve']);
  });
});

describe('watcher integration', () => {
  it('turns a penalty event into a high-prob penalty market', () => {
    const ev: FeedEvent = {
      gameId: 'g1',
      ts: 0,
      type: 'penalty',
      team: 'home',
      text: 'PENALTY!',
      meta: { prob: 0.78 },
    };
    const t = triggerFromEvent(ev, { homeName: 'Argentina' });
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('penalty_scored');
    expect(t!.trueProb).toBeCloseTo(0.78, 2);
    expect(t!.question).toMatch(/Argentina/);
  });

  it('ignores non-bettable events (calm, goal, card)', () => {
    for (const type of ['calm', 'goal', 'card'] as const) {
      const ev: FeedEvent = { gameId: 'g1', ts: 0, type, text: '' };
      expect(triggerFromEvent(ev)).toBeNull();
    }
  });
});
