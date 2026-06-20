import { describe, it, expect } from 'vitest';
import type { FeedEvent } from '@golazo/core';
import {
  MomentumTracker,
  momentumMarketSpec,
  MOMENTUM_GOAL_THRESHOLD,
  MOMENTUM_SHOT_THRESHOLD,
} from './momentum';

const ev = (type: FeedEvent['type'], team?: FeedEvent['team']): FeedEvent => ({
  gameId: 'g',
  ts: 0,
  type,
  ...(team ? { team } : {}),
  text: type,
});

describe('MomentumTracker', () => {
  it('builds toward the pressing side and lights the bar once it dominates', () => {
    const m = new MomentumTracker();
    for (let i = 0; i < 6; i++) {
      m.observe(ev('miss', 'home'));
      m.observe(ev('corner', 'home'));
    }
    const r = m.read();
    expect(r.leader).toBe('home');
    expect(r.bar).toBe('home');
    expect(r.intensity).toBeGreaterThan(MOMENTUM_SHOT_THRESHOLD);
  });

  it('rests neutral when play is even (no runaway leader)', () => {
    const m = new MomentumTracker();
    m.observe(ev('attack', 'home'));
    m.observe(ev('attack', 'away'));
    expect(m.read().bar).toBeNull();
  });

  it('decays — a quiet spell cools the reading off', () => {
    const m = new MomentumTracker();
    m.observe(ev('goal', 'home'));
    const hot = m.read().intensity;
    for (let i = 0; i < 8; i++) m.observe(ev('calm'));
    expect(m.read().intensity).toBeLessThan(hot);
  });
});

describe('momentumMarketSpec', () => {
  it('asks for a GOAL under heavy pressure, a SHOT when merely building', () => {
    const goal = momentumMarketSpec('Türkiye', MOMENTUM_GOAL_THRESHOLD + 1, 'miss', 0);
    expect(goal.kind).toBe('goal_from_open_play');
    expect(goal.question).toMatch(/GOAL|SCORE/);

    const shot = momentumMarketSpec('Türkiye', MOMENTUM_SHOT_THRESHOLD + 0.1, 'other', 0);
    expect(shot.kind).toBe('chance_from_play');
    expect(shot.question).toMatch(/SHOT/);
  });

  it('rotates phrasing so a long spell never repeats the same line', () => {
    const i = MOMENTUM_GOAL_THRESHOLD + 1;
    const a = momentumMarketSpec('Türkiye', i, 'miss', 0).question;
    const b = momentumMarketSpec('Türkiye', i, 'miss', 1).question;
    const c = momentumMarketSpec('Türkiye', i, 'miss', 2).question;
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});
