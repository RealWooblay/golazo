import { describe, expect, it } from 'vitest';
import type { GameState } from '@golazo/core';
import { buildPeriodMarketTrigger, buildGoesToPenaltiesTrigger, parseGameContext, matchPeriodBucket, isSecondHalfStoppageMarket, isFirstHalfStoppageMarket, isEarlyExtraTimeWindow } from './marketTuning';

const baseGame = (over: Partial<GameState> = {}): GameState => ({
  gameId: 'g1',
  sport: 'soccer',
  league: 'WC',
  home: { id: 'h', name: 'Scotland', abbr: 'SCO' },
  away: { id: 'a', name: 'Morocco', abbr: 'MAR' },
  scoreHome: 0,
  scoreAway: 1,
  clock: "93'",
  status: 'live',
  ...over,
});

describe('buildPeriodMarketTrigger', () => {
  it('opens a comeback market for the trailing home side in extra time', () => {
    const t = buildPeriodMarketTrigger(baseGame());
    expect(t).not.toBeNull();
    expect(t!.question).toMatch(/Scotland/i);
    expect(t!.team).toBe('home');
    expect(t!.kind).toBe('goal_in_extra_time');
    expect(t!.slot).toBe('period');
  });

  it('opens a comeback market for the trailing away side', () => {
    const t = buildPeriodMarketTrigger(
      baseGame({ scoreHome: 2, scoreAway: 1, clock: "108'" }),
    );
    expect(t?.question).toMatch(/Morocco/i);
    expect(t?.team).toBe('away');
  });

  it('opens a team-specific ET goal market when level', () => {
    const t = buildPeriodMarketTrigger(
      baseGame({ scoreHome: 1, scoreAway: 1, clock: "93'" }),
    );
    expect(t?.question).toMatch(/Scotland|Morocco/i);
    expect(t?.team).toMatch(/home|away/);
    expect(t?.kind).toBe('goal_in_extra_time');
  });

  it('skips ET goal markets near ET half-time and right after ET kickoff', () => {
    expect(buildPeriodMarketTrigger(baseGame({ clock: "91'" }))).toBeNull();
    expect(buildPeriodMarketTrigger(baseGame({ clock: "104'" }))).toBeNull();
    expect(buildPeriodMarketTrigger(baseGame({ clock: "105+2'" }))).toBeNull();
    expect(buildPeriodMarketTrigger(baseGame({ clock: "106'" }))).toBeNull();
  });

  it('opens a before-full-time market in second-half stoppage', () => {
    const t = buildPeriodMarketTrigger(baseGame({ clock: "90+2'" }));
    expect(t?.question).toMatch(/full-time|FT|whistle/i);
    expect(t?.kind).toBe('goal_in_stoppage');
    expect(t?.slot).toBe('period');
  });

  it('opens a before-half-time market in first-half stoppage (ESPN clock format)', () => {
    const t = buildPeriodMarketTrigger(baseGame({ clock: "45'+1'" }));
    expect(t?.kind).toBe('goal_in_stoppage');
    expect(t?.question).toMatch(/half-time|HT|whistle/i);
  });

  it('parseGameContext detects ESPN stoppage clocks', () => {
    const ctx = parseGameContext(baseGame({ clock: "45'+2'" }));
    expect(ctx.isStoppage).toBe(true);
    expect(ctx.period).toBe('1H');
    expect(ctx.isExtraTime).toBe(false);
  });

  it('skips regular time outside added/extra time', () => {
    expect(buildPeriodMarketTrigger(baseGame({ clock: "88'" }))).toBeNull();
  });

  it('skips blowouts', () => {
    expect(buildPeriodMarketTrigger(baseGame({ scoreHome: 0, scoreAway: 3 }))).toBeNull();
  });
});

describe('buildGoesToPenaltiesTrigger', () => {
  it('opens when level in early ET', () => {
    const t = buildGoesToPenaltiesTrigger(
      baseGame({ scoreHome: 1, scoreAway: 1, clock: "93'" }),
    );
    expect(t?.kind).toBe('goes_to_penalties');
    expect(t?.question).toMatch(/penalt|shootout/i);
    expect(t?.slot).toBe('period');
  });

  it('opens in early second half of ET', () => {
    const t = buildGoesToPenaltiesTrigger(
      baseGame({ scoreHome: 0, scoreAway: 0, clock: "108'" }),
    );
    expect(t?.kind).toBe('goes_to_penalties');
  });

  it('skips when not level', () => {
    expect(
      buildGoesToPenaltiesTrigger(baseGame({ scoreHome: 0, scoreAway: 1, clock: "93'" })),
    ).toBeNull();
  });

  it('skips near ET whistles and right after ET kickoff', () => {
    expect(buildGoesToPenaltiesTrigger(baseGame({ scoreHome: 1, scoreAway: 1, clock: "91'" }))).toBeNull();
    expect(buildGoesToPenaltiesTrigger(baseGame({ scoreHome: 1, scoreAway: 1, clock: "105+2'" }))).toBeNull();
    expect(buildGoesToPenaltiesTrigger(baseGame({ scoreHome: 1, scoreAway: 1, clock: "120+1'" }))).toBeNull();
  });

  it('isEarlyExtraTimeWindow covers mid ET halves', () => {
    expect(isEarlyExtraTimeWindow(baseGame({ clock: "100'" }))).toBe(true);
    expect(isEarlyExtraTimeWindow(baseGame({ clock: "112'" }))).toBe(true);
    expect(isEarlyExtraTimeWindow(baseGame({ clock: "88'" }))).toBe(false);
  });
});

describe('parseGameContext extra time', () => {
  it('detects ET from clock', () => {
    const ctx = parseGameContext(baseGame({ clock: "91'" }));
    expect(ctx.isExtraTime).toBe(true);
    expect(ctx.period).toBe('ET');
    expect(ctx.isPenaltyShootout).toBe(false);
  });

  it('detects penalty shootout from clock/status and suppresses ET', () => {
    const ctx = parseGameContext(
      baseGame({ clock: 'Penalty Shootout', penaltyShootout: true }),
    );
    expect(ctx.isPenaltyShootout).toBe(true);
    expect(ctx.isExtraTime).toBe(false);
    expect(buildPeriodMarketTrigger(baseGame({ clock: 'Penalty Shootout', penaltyShootout: true }))).toBeNull();
  });

  it('treats clocks past 120 as shootout', () => {
    const ctx = parseGameContext(baseGame({ clock: "121'" }));
    expect(ctx.isPenaltyShootout).toBe(true);
    expect(ctx.period).toBe('PK');
  });
});

describe('matchPeriodBucket — FT vs ET boundary', () => {
  it('keeps 2H stoppage in the regulation bucket', () => {
    expect(matchPeriodBucket(90.07)).toBe('second');
    expect(isSecondHalfStoppageMarket('goal_in_stoppage', 90.07)).toBe(true);
  });

  it('puts ET minutes in the extra bucket', () => {
    expect(matchPeriodBucket(91)).toBe('extra');
    expect(isSecondHalfStoppageMarket('goal_in_stoppage', 90.07)).toBe(true);
    expect(isSecondHalfStoppageMarket('goal_in_stoppage', 91)).toBe(false);
  });

  it('classifies 1H stoppage separately', () => {
    expect(matchPeriodBucket(45.02)).toBe('first');
    expect(isFirstHalfStoppageMarket('goal_in_stoppage', 45.02)).toBe(true);
    expect(isFirstHalfStoppageMarket('goal_in_stoppage', 90.05)).toBe(false);
  });
});
