import { describe, it, expect } from 'vitest';
import {
  inferPlayPhase,
  transitionPlayPhase,
  goalCorroborated,
  parseGoalSource,
} from './playPhase';
import type { FeedEvent } from '@golazo/core';

describe('play phase state machine', () => {
  it('transitions buildup → shooting → calm on goal', () => {
    let phase = 'calm' as const;
    phase = transitionPlayPhase(phase, {
      gameId: 'g',
      ts: 1,
      type: 'attack',
      text: 'Surging',
    });
    expect(phase).toBe('buildup');
    phase = transitionPlayPhase(phase, {
      gameId: 'g',
      ts: 2,
      type: 'shot',
      text: 'Shot',
    });
    expect(phase).toBe('shooting');
    phase = transitionPlayPhase(phase, {
      gameId: 'g',
      ts: 3,
      type: 'goal',
      text: 'Goal!',
      team: 'home',
    });
    expect(phase).toBe('calm');
  });

  it('infers set_piece from FK keyEvent', () => {
    expect(
      inferPlayPhase({ gameId: 'g', ts: 1, type: 'free_kick', text: 'FK' }),
    ).toBe('set_piece');
  });
});

describe('goalCorroborated', () => {
  it('confirms goal when commentary matches', () => {
    const goal: FeedEvent = {
      gameId: 'g',
      ts: 2,
      type: 'goal',
      team: 'home',
      text: 'Goal! Brazil 1, Haiti 0.',
    };
    const commentary: FeedEvent[] = [
      { gameId: 'g', ts: 2, type: 'attack', team: 'home', text: 'Goal! Brazil take the lead.' },
    ];
    expect(goalCorroborated(goal, commentary)).toBe(true);
  });
});

describe('parseGoalSource — rules first', () => {
  it('YES for direct FK goal text', () => {
    expect(
      parseGoalSource('Matheus Cunha scores from a direct free kick.', 'goal_from_free_kick'),
    ).toBe('yes');
  });
});
