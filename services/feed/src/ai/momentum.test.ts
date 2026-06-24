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
  it('asks for a SCORE window under heavy pressure, a SHOT window when merely building', () => {
    const score = momentumMarketSpec('Türkiye', MOMENTUM_GOAL_THRESHOLD + 1, 0);
    expect(score.kind).toBe('score_in_window');
    expect(score.question).toMatch(/score|goal/i);

    // Lighter pressure alternates by the counter: ODD → the narrow "shot" window
    const shot = momentumMarketSpec('Türkiye', MOMENTUM_SHOT_THRESHOLD + 0.1, 1);
    expect(shot.kind).toBe('shot_in_window');
    expect(shot.question).toMatch(/shot/i);

    // …EVEN → the broader, higher-YES "shot or corner" window.
    const broad = momentumMarketSpec('Türkiye', MOMENTUM_SHOT_THRESHOLD + 0.1, 0);
    expect(broad.kind).toBe('shot_or_corner_in_window');
    expect(broad.question).toMatch(/shot or corner/i);
  });

  it('rotates phrasing so a long spell never repeats the same line', () => {
    const i = MOMENTUM_GOAL_THRESHOLD + 1;
    const a = momentumMarketSpec('Türkiye', i, 0).question;
    const b = momentumMarketSpec('Türkiye', i, 1).question;
    const c = momentumMarketSpec('Türkiye', i, 2).question;
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});
