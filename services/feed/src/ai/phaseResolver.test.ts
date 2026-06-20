import { describe, it, expect } from 'vitest';
import type { FeedEvent } from '@golazo/core';
import { commentaryEndsSetPiecePhase } from './phaseResolver';

const ev = (
  type: FeedEvent['type'],
  clock: string,
  text = '',
  source = 'espn.commentary',
): FeedEvent => ({
  gameId: 'g1',
  ts: Date.now(),
  type,
  text,
  meta: { clock, source },
});

describe('commentaryEndsSetPiecePhase', () => {
  it('detects play_end commentary after market opened', () => {
    const events = [
      ev('play_end', "5'", 'Short pass from the free kick.'),
      ev('attack', "6'", 'Türkiye pushing forward.'),
    ];
    expect(commentaryEndsSetPiecePhase(events, 'free_kick', 4)).toBe(true);
  });

  it('ignores commentary before the market opened', () => {
    const events = [ev('play_end', "3'", 'Short pass from the free kick.')];
    expect(commentaryEndsSetPiecePhase(events, 'free_kick', 4)).toBe(false);
  });

  it('detects miss commentary', () => {
    const events = [ev('miss', "5'", 'Attempt saved. Player shot.')];
    expect(commentaryEndsSetPiecePhase(events, 'free_kick', 4)).toBe(true);
  });
});
