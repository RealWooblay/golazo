import { describe, it, expect } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import {
  feedLagMinutes,
  goalAlreadyHappenedForChance,
  isAwardedFreeKick,
  isDefensiveSetPiece,
  isStalePlay,
  resolveDeadlineMs,
  resolvePolicyFor,
  scaledResolveWindowMs,
  staleLagThreshold,
} from './marketTuning';

const game = (clock: string): GameState => ({
  gameId: 'g1',
  home: { name: 'Brazil', abbr: 'BRA' },
  away: { name: 'Haiti', abbr: 'HAI' },
  scoreHome: 0,
  scoreAway: 0,
  clock,
  status: 'live',
});

const ev = (type: FeedEvent['type'], clock: string): FeedEvent => ({
  gameId: 'g1',
  ts: Date.now(),
  type,
  text: 'test',
  meta: { clock, source: 'espn.keyEvent' },
});

describe('feed lag / stale detection', () => {
  it('flags set-pieces more than 30s behind live clock', () => {
    expect(isStalePlay(ev('corner', "67'"), game("69'"))).toBe(true);
    expect(isStalePlay(ev('corner', "68'"), game("68'"))).toBe(false);
    expect(isStalePlay(ev('corner', "68'"), game("69'"))).toBe(true);
    expect(isStalePlay(ev('corner', "68+1'"), game("69'"))).toBe(true);
  });

  it('allows slightly more lag for fuzzy open-play moments', () => {
    expect(staleLagThreshold('attack')).toBeGreaterThan(staleLagThreshold('corner'));
    expect(isStalePlay(ev('attack', "61'"), game("62'"))).toBe(false);
    expect(isStalePlay(ev('attack', "58'"), game("60'"))).toBe(true);
  });

  it('computes fractional stoppage lag', () => {
    expect(feedLagMinutes(ev('corner', "90'"), game("90+2'"))).toBeCloseTo(0.02, 2);
  });
});

describe('goalAlreadyHappenedForChance', () => {
  it('settles YES when a goal for that team was already recorded at the chance clock', () => {
    const resolvers = new Map<Team, number>([['home', 34]]);
    expect(goalAlreadyHappenedForChance('home', 34, resolvers)).toBe(true);
    expect(goalAlreadyHappenedForChance('home', 36, resolvers)).toBe(false);
    expect(goalAlreadyHappenedForChance('away', 34, resolvers)).toBe(false);
  });
});

describe('scaledResolveWindowMs', () => {
  it('stretches open-play opener windows modestly in late game', () => {
    const w = scaledResolveWindowMs('dangerous_attack', game("70'"));
    expect(w).toBeGreaterThanOrEqual(55_000);
    expect(w).toBeLessThanOrEqual(75_000);
  });
});

describe('resolveDeadlineMs — soccer-realistic locked countdowns', () => {
  it('gives pressing spells ~2 minutes, set-pieces ~90s, shots ~60s', () => {
    expect(resolveDeadlineMs('goal_from_open_play')).toBe(120_000);
    expect(resolveDeadlineMs('goal_from_corner')).toBe(90_000);
    // A single move is short — the "shot this move?" market resolves fast so the
    // lone market slot frees for the next moment (often a set-piece).
    expect(resolveDeadlineMs('chance_from_play')).toBe(30_000);
    expect(resolveDeadlineMs('red_card_given')).toBe(120_000);
  });
});

describe('free-kick location gating — attacking only, never defensive', () => {
  const fk = (text: string, source?: 'espn.keyEvent'): FeedEvent => ({
    gameId: 'g1',
    ts: 0,
    type: 'free_kick',
    team: 'home',
    text,
    ...(source ? { meta: { source } } : {}),
  });

  it('opens an attacking-half awarded free kick', () => {
    expect(isAwardedFreeKick(fk('Casemiro (Brazil) wins a free kick in the attacking half.'))).toBe(
      true,
    );
  });

  it('does NOT open an own-half / defensive free kick', () => {
    expect(isAwardedFreeKick(fk('Paraguay wins a free kick in their own half.'))).toBe(false);
    expect(isAwardedFreeKick(fk('Wins a free kick in the defensive half.'))).toBe(false);
    expect(isDefensiveSetPiece('a free kick in their own penalty area')).toBe(true);
  });

  it('does NOT instant-open a bare "wins a free kick" with no location (→ AI judges)', () => {
    expect(isAwardedFreeKick(fk('Neymar wins a free kick.'))).toBe(false);
  });

  it('does NOT instant-open a bare keyEvent free kick without an attacking zone', () => {
    expect(isAwardedFreeKick(fk('Foul by Croatia.', 'espn.keyEvent'))).toBe(false);
    expect(isAwardedFreeKick(fk('Free kick in the attacking third.', 'espn.keyEvent'))).toBe(true);
  });

  it('opens Spanish attacking-zone free kicks, rejects defensive ones', () => {
    expect(isAwardedFreeKick(fk('Vinícius ha recibido una falta en campo contrario.'))).toBe(true);
    expect(isAwardedFreeKick(fk('ha recibido una falta en zona defensiva.'))).toBe(false);
  });
});

describe('event-driven resolution policy', () => {
  it('goal markets use event_only policy', () => {
    expect(resolvePolicyFor('goal_from_free_kick')).toBe('event_only');
    expect(resolvePolicyFor('penalty_awarded')).toBe('timeout_no');
  });
});
