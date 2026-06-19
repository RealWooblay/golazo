import { describe, it, expect } from 'vitest';
import type { FeedEvent } from '@golazo/core';
import { classifyCommentary, mapKeyEventType, parseClockKey, EspnFeed } from './espn';

describe('classifyCommentary — opportunity detection from prose', () => {
  it('detects AWARDED set-pieces (clean pre-outcome signals)', () => {
    expect(classifyCommentary('Penalty awarded to England!')).toBe('penalty');
    expect(classifyCommentary('Corner, Croatia. Conceded by Stones.')).toBe('corner');
    expect(classifyCommentary('Free kick in a dangerous area for England.')).toBe('free_kick');
  });

  it('does NOT treat "penalty area/box" (a location) as a penalty award', () => {
    expect(classifyCommentary('The ball is worked into the penalty area.')).not.toBe('penalty');
    expect(classifyCommentary('Cleared from the penalty box.')).not.toBe('penalty');
  });

  it('detects open-play build-up as fuzzy attacks', () => {
    expect(classifyCommentary('Kane breaks through, one-on-one with the keeper!')).toBe('dangerous_attack');
    expect(classifyCommentary('England surging forward, building pressure.')).toBe('attack');
  });

  it('captures live attacking phrasings that used to slip through', () => {
    // These were the CAPTURE GAP — real chances that produced no market.
    expect(classifyCommentary('Header from six yards, forces a save!')).toBe('dangerous_attack');
    expect(classifyCommentary('A clear chance opens up for Kane.')).toBe('dangerous_attack');
    expect(classifyCommentary('The rebound falls to Saka in the box!')).toBe('dangerous_attack');
    expect(classifyCommentary('Cut-back into the danger zone.')).toBe('dangerous_attack');
    expect(classifyCommentary('Whipped in from the right wing.')).toBe('attack');
    expect(classifyCommentary('Half a chance there for Croatia.')).toBe('attack');
  });

  it('ignores non-events', () => {
    expect(classifyCommentary('Throw-in, recycled at the back.')).toBeUndefined();
    expect(classifyCommentary('Lineups are announced.')).toBeUndefined();
  });
});

describe('mapKeyEventType — structured plays', () => {
  it('maps goals (incl. scored penalties) to "goal"', () => {
    expect(mapKeyEventType({ scoringPlay: true, type: { text: 'Goal' } })).toBe('goal');
    expect(mapKeyEventType({ type: { text: 'Penalty - Scored' }, text: 'Kane converts' })).toBe('goal');
  });
  it('maps missed/saved penalties + shots to "miss"', () => {
    expect(mapKeyEventType({ type: { text: 'Penalty - Missed' } })).toBe('miss');
    expect(mapKeyEventType({ type: { text: 'Shot' }, text: 'effort off target, wide' })).toBe('miss');
  });
  it('maps a penalty AWARD (not yet taken) to the bettable "penalty" opener', () => {
    expect(mapKeyEventType({ type: { text: 'Penalty' }, text: 'Penalty awarded' })).toBe('penalty');
  });
  it('maps cards and ignores noise', () => {
    expect(mapKeyEventType({ type: { text: 'Yellow Card' } })).toBe('card');
    expect(mapKeyEventType({ type: { text: 'Substitution' } })).toBeUndefined();
  });
});

describe('parseClockKey — stoppage-aware', () => {
  it('parses regulation and stoppage clocks', () => {
    expect(parseClockKey("45'")).toEqual({ base: 45, stopp: 0 });
    expect(parseClockKey("45+2'")).toEqual({ base: 45, stopp: 2 });
    expect(parseClockKey("90+5'")).toEqual({ base: 90, stopp: 5 });
    expect(parseClockKey(undefined)).toEqual({ base: 0, stopp: 0 });
  });
});

describe('EspnFeed.poll — chronological, openers before same-clock resolvers (no lookahead)', () => {
  const scoreboard = {
    events: [
      {
        id: 'e1',
        status: { type: { state: 'in' }, displayClock: "23'" },
        competitions: [
          {
            competitors: [
              { homeAway: 'home', score: '0', team: { id: 'eng', displayName: 'England', abbreviation: 'ENG' } },
              { homeAway: 'away', score: '0', team: { id: 'cro', displayName: 'Croatia', abbreviation: 'CRO' } },
            ],
          },
        ],
      },
    ],
  };
  // A goal keyEvent and its build-up commentary BOTH first appear in the same poll,
  // both stamped 23'. The opener (commentary) must be emitted before the goal.
  const summary = {
    keyEvents: [
      { sequence: 5, clock: { displayValue: "23'" }, type: { text: 'Goal' }, text: 'Goal! England.', team: { id: 'eng' }, scoringPlay: true },
    ],
    commentary: [
      { sequence: 1, time: { displayValue: "23'" }, text: 'England break through, one-on-one with the keeper!' },
    ],
  };

  it('returns the opening attack before the goal that resolves it', async () => {
    const fetchImpl = (async (url: string) =>
      ({ ok: true, status: 200, json: async () => (String(url).includes('/summary') ? summary : scoreboard) }) as Response) as unknown as typeof fetch;

    const feed = new EspnFeed({ league: 'fifa.world', fetchImpl });
    expect(await feed.start()).toBe(true);

    const events = await feed.poll(Date.now());
    const types = events.map((e: FeedEvent) => e.type);
    const opener = types.findIndex((t) => t === 'dangerous_attack' || t === 'attack');
    const goal = types.indexOf('goal');
    expect(opener).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThanOrEqual(0);
    expect(opener).toBeLessThan(goal); // build-up emitted before the goal — no lookahead
  });
});
