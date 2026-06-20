import { describe, it, expect } from 'vitest';
import type { FeedEvent } from '@golazo/core';
import { endsPlayPhase, parseGoalSource, shouldForceSettleLockedNo } from './playPhase';

const ev = (type: FeedEvent['type'], team?: 'home' | 'away', text = ''): FeedEvent => ({
  gameId: 'g1',
  ts: Date.now(),
  type,
  text,
  ...(team ? { team } : {}),
});

describe('parseGoalSource — ESPN goal text, not commentary keywords', () => {
  it('YES when ESPN says the goal came from the free kick', () => {
    expect(
      parseGoalSource(
        'Goal! Brazil 1-0. Casemiro (Brazil) header from a direct free kick.',
        'goal_from_free_kick',
      ),
    ).toBe('yes');
  });

  it('NO when ESPN says assisted — recycled possession after wall', () => {
    expect(
      parseGoalSource(
        'Goal! Brazil 2-0. Vinícius Júnior (Brazil) right footed shot from the left side of the box. Assisted by Lucas Paquetá with a through ball.',
        'goal_from_free_kick',
      ),
    ).toBe('no');
  });

  it('NO for corner market when goal is a through-ball assist', () => {
    expect(
      parseGoalSource(
        'Goal! Kane (England) right footed shot. Assisted by Saka with a through ball.',
        'goal_from_corner',
      ),
    ).toBe('no');
  });
});

describe('endsPlayPhase — structured events only', () => {
  it('open-play attack after FK ends the FK phase', () => {
    expect(endsPlayPhase(ev('dangerous_attack', 'home'), 'home', 'free_kick')).toBe(true);
  });

  it('does not end phase on stoppage start', () => {
    expect(
      endsPlayPhase(
        { ...ev('calm'), meta: { delay: 'start' } },
        'home',
        'free_kick',
      ),
    ).toBe(false);
  });

  it('play resumes after delay ends the FK phase', () => {
    expect(
      endsPlayPhase(
        { ...ev('calm', 'Play resumes'), meta: { delay: 'end' } },
        'home',
        'free_kick',
      ),
    ).toBe(true);
  });

  it('miss ends the phase', () => {
    expect(endsPlayPhase(ev('miss', 'home'), 'home', 'free_kick')).toBe(true);
  });

  it('same-team goal does not end phase (it resolves it)', () => {
    expect(endsPlayPhase(ev('goal', 'home'), 'home', 'free_kick')).toBe(false);
  });

  describe('open-play "on this play" possession phase (chance_from_play)', () => {
    it('OPPONENT attack ends our move (possession lost → NO)', () => {
      expect(endsPlayPhase(ev('attack', 'away'), 'home', 'attack')).toBe(true);
      expect(endsPlayPhase(ev('dangerous_attack', 'away'), 'home', 'attack')).toBe(true);
    });

    it('our own continued attack does NOT end the move (it keeps going)', () => {
      expect(endsPlayPhase(ev('attack', 'home'), 'home', 'attack')).toBe(false);
      expect(endsPlayPhase(ev('dangerous_attack', 'home'), 'home', 'attack')).toBe(false);
    });

    it('opponent goal ends our move (NO)', () => {
      expect(endsPlayPhase(ev('goal', 'away'), 'home', 'attack')).toBe(true);
    });
  });
});

describe('shouldForceSettleLockedNo', () => {
  it('forces NO when live clock moved past drift window', () => {
    expect(
      shouldForceSettleLockedNo('goal_from_free_kick', 10_000, 50_000, 4, 6, true),
    ).toBe(true);
  });

  it('forces NO when locked longer than resolve window cap', () => {
    expect(
      shouldForceSettleLockedNo('goal_from_free_kick', 120_000, 50_000, 4, 4.5, true),
    ).toBe(true);
  });

  it('does not force while still inside drift and time window', () => {
    expect(
      shouldForceSettleLockedNo('goal_from_free_kick', 20_000, 50_000, 4, 4.5, true),
    ).toBe(false);
  });
});
