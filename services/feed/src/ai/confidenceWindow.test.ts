import { describe, it, expect } from 'vitest';
import { confidenceWindowMs } from './marketTuning';
import type { GameState } from '@golazo/core';

const game: GameState = {
  gameId: 'g1',
  sport: 'soccer',
  league: 'fifa.world',
  home: { id: 'h', name: 'A', abbr: 'A' },
  away: { id: 'a', name: 'B', abbr: 'B' },
  scoreHome: 0,
  scoreAway: 0,
  clock: "44'",
  status: 'live',
};

describe('confidenceWindowMs', () => {
  it('extends window for high confidence', () => {
    const low = confidenceWindowMs(10_000, 0.3, game);
    const high = confidenceWindowMs(10_000, 0.9, game);
    expect(high).toBeGreaterThan(low);
  });
});
