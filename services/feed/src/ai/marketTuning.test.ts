import { describe, it, expect } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import {
  countEventTypes,
  countLine,
  feedLagMinutes,
  goalAlreadyHappenedForChance,
  inWhistleZone,
  isAwardedFreeKick,
  isCountKind,
  isDefensiveSetPiece,
  isStalePlay,
  isWhichSideNextKind,
  decisiveEventTypes,
  marketSlot,
  resolveDeadlineMs,
  scaledResolveWindowMs,
  staleLagThreshold,
} from './marketTuning';

const game = (clock: string): GameState => ({
  gameId: 'g1',
  sport: 'soccer',
  league: 'WC',
  home: { id: 'bra', name: 'Brazil', abbr: 'BRA' },
  away: { id: 'hai', name: 'Haiti', abbr: 'HAI' },
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
  it('stretches set-piece opener windows modestly in late game', () => {
    const w = scaledResolveWindowMs('corner', game("70'"));
    expect(w).toBeGreaterThanOrEqual(85_000);
    expect(w).toBeLessThanOrEqual(115_000);
  });
});

describe('resolveDeadlineMs — soccer-realistic locked countdowns', () => {
  it('gives pressing spells ~2 minutes, set-pieces ~60s, shots ~30s', () => {
    expect(resolveDeadlineMs('goal_from_open_play')).toBe(120_000);
    expect(resolveDeadlineMs('goal_from_corner')).toBe(60_000);
    // A single move is short — the "shot this move?" market resolves fast so the
    // lone market slot frees for the next moment (often a set-piece).
    expect(resolveDeadlineMs('chance_from_play')).toBe(30_000);
    expect(resolveDeadlineMs('red_card_given')).toBe(120_000);
  });

  it('gives momentum time-boxed markets their own windows', () => {
    expect(resolveDeadlineMs('shot_in_window')).toBe(90_000);
    expect(resolveDeadlineMs('score_in_window')).toBe(120_000);
  });
});

describe('marketSlot', () => {
  it('classifies moment/window/period markets', () => {
    expect(marketSlot('goal_from_free_kick')).toBe('moment');
    expect(marketSlot('shot_in_window')).toBe('window');
    expect(marketSlot('goal_in_stoppage')).toBe('period');
    expect(marketSlot('goal_in_extra_time')).toBe('period');
    expect(marketSlot('goes_to_penalties')).toBe('period');
  });

  it('classifies the PHASE 2 window/event/count kinds', () => {
    expect(marketSlot('shot_or_corner_in_window')).toBe('window');
    expect(marketSlot('card_in_window')).toBe('event');
    expect(marketSlot('goal_in_window')).toBe('event');
    expect(marketSlot('over_corners')).toBe('count');
    expect(marketSlot('over_shots')).toBe('count');
  });
});

describe('PHASE 2 deadlines + count helpers', () => {
  it('gives the new kinds soccer-realistic deadlines', () => {
    expect(resolveDeadlineMs('shot_or_corner_in_window')).toBe(90_000);
    expect(resolveDeadlineMs('card_in_window')).toBe(180_000);
    expect(resolveDeadlineMs('goal_in_window')).toBe(300_000);
    // count deadlines = counting window + feed lag (so a late event still counts)
    expect(resolveDeadlineMs('over_corners')).toBeGreaterThan(240_000);
    expect(resolveDeadlineMs('over_shots')).toBeGreaterThan(240_000);
  });

  it('exposes the over/under line + counting event types per count kind', () => {
    expect(isCountKind('over_corners')).toBe(true);
    expect(isCountKind('over_shots')).toBe(true);
    expect(isCountKind('shot_in_window')).toBe(false);

    expect(countLine('over_corners')).toBe(1);
    expect(countLine('over_shots')).toBe(2);

    expect([...countEventTypes('over_corners')]).toEqual(['corner']);
    expect(new Set(countEventTypes('over_shots'))).toEqual(new Set(['shot', 'miss', 'goal']));
  });
});

describe('PHASE 6 which-side-next palette', () => {
  it('classifies only the next_* contest kinds as which-side', () => {
    expect(isWhichSideNextKind('next_shot')).toBe(true);
    expect(isWhichSideNextKind('next_corner')).toBe(true);
    expect(isWhichSideNextKind('next_goal')).toBe(true);
    expect(isWhichSideNextKind('next_card')).toBe(true);
    expect(isWhichSideNextKind('shot_in_window')).toBe(false);
    expect(isWhichSideNextKind('over_corners')).toBe(false);
  });

  it('decides next_card on a booking by either team, and maps to the versus slot', () => {
    const set = decisiveEventTypes('next_card');
    expect(set.has('yellow_card')).toBe(true);
    expect(set.has('red_card')).toBe(true);
    expect(set.has('shot')).toBe(false);
    expect(marketSlot('next_card')).toBe('versus');
    expect(resolveDeadlineMs('next_card')).toBeGreaterThan(0);
  });

  it('decides next_shot on a REAL shot only (not a corner / dangerous attack), versus slot', () => {
    const set = decisiveEventTypes('next_shot');
    for (const t of ['shot', 'miss', 'goal'] as const) {
      expect(set.has(t)).toBe(true);
    }
    // A corner or a fuzzy "dangerous attack" must NOT settle a "Next shot" contest.
    for (const t of ['corner', 'dangerous_attack', 'free_kick'] as const) {
      expect(set.has(t)).toBe(false);
    }
    expect(marketSlot('next_shot')).toBe('versus');
    expect(resolveDeadlineMs('next_shot')).toBeGreaterThan(0);
  });
});

describe('PHASE 4a HT/FT/ET boundary guard (inWhistleZone)', () => {
  it('suppresses short play markets near the half/full-time whistle', () => {
    // Normal regulation play — fine, there is enough runway to settle.
    expect(inWhistleZone(game("30'"))).toBe(false);
    expect(inWhistleZone(game("80'"))).toBe(false);
    // Late regulation and stoppage — the whistle can cut a short market off.
    expect(inWhistleZone(game("44'"))).toBe(true);
    expect(inWhistleZone(game("89'"))).toBe(true);
    expect(inWhistleZone(game("45+2'"))).toBe(true);
    expect(inWhistleZone(game("90+3'"))).toBe(true);
  });

  it('suppresses short play markets near ET half-time and ET full-time', () => {
    expect(inWhistleZone(game("98'"))).toBe(false);
    expect(inWhistleZone(game("104'"))).toBe(true);
    expect(inWhistleZone(game("105+1'"))).toBe(true);
    expect(inWhistleZone(game("112'"))).toBe(false);
    expect(inWhistleZone(game("119'"))).toBe(true);
    expect(inWhistleZone(game("120+2'"))).toBe(true);
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
