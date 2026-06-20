import { describe, it, expect } from 'vitest';
import type { FeedEvent } from '@golazo/core';
import { EspnReplayFeed } from './replay';

/** A fake fetch returning canned ESPN scoreboard + summary JSON (no network). */
function fakeFetch(scoreboard: unknown, summary: unknown): typeof fetch {
  return (async (url: string) => {
    const body = String(url).includes('/summary') ? summary : scoreboard;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

const SCOREBOARD = {
  events: [
    {
      id: 'e1',
      status: { type: { state: 'post' } },
      competitions: [
        {
          competitors: [
            { homeAway: 'home', score: '1', team: { id: 'eng', displayName: 'England', abbreviation: 'ENG' } },
            { homeAway: 'away', score: '0', team: { id: 'cro', displayName: 'Croatia', abbreviation: 'CRO' } },
          ],
        },
      ],
    },
  ],
};

// A penalty AWARDED (commentary, 11') precedes the structured "Penalty - Scored"
// keyEvent (12'). The honest invariant: the opener is emitted before the resolver.
const SUMMARY = {
  commentary: [
    { sequence: 1, time: { displayValue: "11'" }, text: 'Penalty awarded to England! Up steps the taker.' },
    { sequence: 2, time: { displayValue: "40'" }, text: 'England break through, one-on-one with the keeper!' },
  ],
  keyEvents: [
    {
      sequence: 10,
      clock: { displayValue: "12'" },
      type: { text: 'Penalty - Scored' },
      text: 'Goal! Harry Kane converts.',
      team: { id: 'eng' },
      scoringPlay: true,
    },
  ],
};

const OPENERS = new Set<FeedEvent['type']>(['penalty', 'corner', 'free_kick', 'dangerous_attack', 'attack']);
const RESOLVERS = new Set<FeedEvent['type']>(['goal', 'miss']);

describe('EspnReplayFeed — regression: Spanish FK + post-shot guard', () => {
  const esSummary = {
    commentary: [
      {
        sequence: 1,
        time: { displayValue: "4'" },
        text: 'Gabriel Magalhães (Brasil) ha recibido una falta en campo contrario.',
      },
      {
        sequence: 2,
        time: { displayValue: "29'" },
        text: 'Remate parado por bajo. Raphinha (Brasil) remate con la izquierda.',
      },
    ],
    keyEvents: [
      {
        sequence: 10,
        clock: { displayValue: "23'" },
        scoringPlay: true,
        type: { text: 'Gol' },
        text: 'Goal! Brazil 1, Haiti 0.',
        team: { id: 'bra' },
      },
    ],
  };
  const braHaiBoard = {
    events: [
      {
        id: '760444',
        status: { type: { state: 'post' } },
        competitions: [
          {
            competitors: [
              { homeAway: 'home', score: '3', team: { id: 'bra', displayName: 'Brazil', abbreviation: 'BRA' } },
              { homeAway: 'away', score: '0', team: { id: 'hai', displayName: 'Haiti', abbreviation: 'HAI' } },
            ],
          },
        ],
      },
    ],
  };

  it('classifies Spanish FK as opener and rejects post-shot line', async () => {
    const { classifyCommentary } = await import('./espn');
    expect(
      classifyCommentary('Gabriel Magalhães (Brasil) ha recibido una falta en campo contrario.'),
    ).toBe('free_kick');
    expect(classifyCommentary('Remate parado por bajo. Raphinha (Brasil) remate.')).toBeUndefined();
  });

  it('replay emits FK before goal', async () => {
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: '760444',
      fetchImpl: fakeFetch(braHaiBoard, esSummary),
    });
    await feed.start();
    const all = feed.poll(Date.now() + 10_000_000);
    const types = all.map((e) => e.type);
    const fk = types.indexOf('free_kick');
    const goal = types.indexOf('goal');
    expect(fk).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThanOrEqual(0);
    expect(fk).toBeLessThan(goal);
  });
});

describe('EspnReplayFeed — no-lookahead chronological replay', () => {
  it('emits the opportunity (penalty awarded) BEFORE the outcome (goal)', async () => {
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: 'e1',
      fetchImpl: fakeFetch(SCOREBOARD, SUMMARY),
    });
    const started = await feed.start();
    expect(started).toBe(true);

    // Drain the whole timeline (far-future `now`); returned in chronological order.
    const all = feed.poll(Date.now() + 10_000_000);
    const types = all.map((e) => e.type);

    const firstOpener = types.findIndex((t) => OPENERS.has(t));
    const firstResolver = types.findIndex((t) => RESOLVERS.has(t));

    expect(firstOpener).toBeGreaterThanOrEqual(0); // a market-opening event exists
    expect(firstResolver).toBeGreaterThanOrEqual(0); // a resolving event exists
    // THE INVARIANT: never a resolution before the opportunity that it settles.
    expect(firstOpener).toBeLessThan(firstResolver);
  });

  it('attributes the goal to the correct team and advances that score', async () => {
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: 'e1',
      fetchImpl: fakeFetch(SCOREBOARD, SUMMARY),
    });
    await feed.start();
    const all = feed.poll(Date.now() + 10_000_000);

    const goal = all.find((e) => e.type === 'goal');
    expect(goal?.team).toBe('home'); // England scored, not Croatia
    expect(feed.state().scoreHome).toBe(1);
    expect(feed.state().scoreAway).toBe(0);
  });

  it('starts the scoreline at 0-0 (we do not leak the final score up front)', async () => {
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: 'e1',
      fetchImpl: fakeFetch(SCOREBOARD, SUMMARY),
    });
    await feed.start();
    // Before any poll, no outcome has been revealed.
    expect(feed.state().scoreHome).toBe(0);
    expect(feed.state().scoreAway).toBe(0);
  });
});
