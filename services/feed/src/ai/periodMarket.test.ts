import { describe, expect, it } from 'vitest';
import type { GameState } from '@golazo/core';
import { buildPeriodMarketTrigger, parseGameContext } from './marketTuning';

const baseGame = (over: Partial<GameState> = {}): GameState => ({
  gameId: 'g1',
  sport: 'soccer',
  league: 'WC',
  home: { id: 'h', name: 'Scotland', abbr: 'SCO' },
  away: { id: 'a', name: 'Morocco', abbr: 'MAR' },
  scoreHome: 0,
  scoreAway: 1,
  clock: "91'",
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
      baseGame({ scoreHome: 2, scoreAway: 1, clock: "105'" }),
    );
    expect(t?.question).toMatch(/Morocco/i);
    expect(t?.team).toBe('away');
  });

  it('opens a generic ET goal market when level', () => {
    const t = buildPeriodMarketTrigger(
      baseGame({ scoreHome: 1, scoreAway: 1, clock: "92'" }),
    );
    expect(t?.question).toMatch(/extra time|ET|deadlock/i);
    expect(t?.team).toBeUndefined();
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

describe('parseGameContext extra time', () => {
  it('detects ET from clock', () => {
    const ctx = parseGameContext(baseGame({ clock: "91'" }));
    expect(ctx.isExtraTime).toBe(true);
    expect(ctx.period).toBe('ET');
  });
});
