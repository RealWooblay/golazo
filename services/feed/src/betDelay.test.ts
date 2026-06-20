import { describe, it, expect } from 'vitest';
import { canAcceptBetNow } from './betDelay';

describe('canAcceptBetNow', () => {
  const market = {
    status: 'open',
    lockAt: 10_000,
    windowMs: 8_000,
  };

  it('accepts before the safety buffer closes betting', () => {
    expect(canAcceptBetNow(market, 7_000)).toBe(true);
  });

  it('rejects inside the safety buffer', () => {
    expect(canAcceptBetNow(market, 8_500)).toBe(false);
  });

  it('rejects when market is locked or missing', () => {
    expect(canAcceptBetNow({ ...market, status: 'locked' }, 5_000)).toBe(false);
    expect(canAcceptBetNow(undefined, 5_000)).toBe(false);
  });
});
