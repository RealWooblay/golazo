import { describe, it, expect } from 'vitest';
import type { FeedEvent, GameState } from '@golazo/core';
import { classifyCommentary, mapKeyEventType, parseClockKey, parseAwardedTeamFromCommentary, momentKey, EspnFeed } from './espn';

describe('classifyCommentary — opportunity detection from prose', () => {
  it('detects AWARDED set-pieces (clean pre-outcome signals)', () => {
    expect(classifyCommentary('Penalty awarded to England!')).toBe('penalty');
    expect(
      classifyCommentary('Gabriel Magalhães (Brazil) wins a free kick in the attacking half.'),
    ).toBe('free_kick');
  });

  it('classifies corners from ESPN canonical commentary lines', () => {
    expect(classifyCommentary('Corner, Croatia. Conceded by Stones.')).toBe('corner');
    expect(classifyCommentary('Corner, Türkiye.')).toBe('corner');
    expect(classifyCommentary('Saque de esquina, Paraguay.')).toBe('corner');
    expect(classifyCommentary('Tiro de esquina - Türkiye.')).toBe('corner');
  });

  it('does NOT treat "penalty area/box" or "corner flag" (locations) as set-pieces', () => {
    expect(classifyCommentary('The ball is worked into the penalty area.')).not.toBe('penalty');
    expect(classifyCommentary('Cleared from the penalty box.')).not.toBe('penalty');
    expect(classifyCommentary('Near the corner flag, Morocco recycle possession.')).not.toBe('corner');
    expect(classifyCommentary('Played into the corner of the pitch.')).not.toBe('corner');
  });

  it('detects open-play build-up as fuzzy attacks', () => {
    expect(classifyCommentary('Kane breaks through, one-on-one with the keeper!')).toBe('dangerous_attack');
    expect(classifyCommentary('England surging forward, building pressure.')).toBe('attack');
  });

  it('rejects POST-SHOT ESPN lines (Brazil/Haiti style) — never open on these', () => {
    expect(classifyCommentary('Attempt saved. Vinícius Júnior (Brazil) right footed shot.')).toBeUndefined();
    expect(classifyCommentary('Attempt blocked. Wilson Isidor (Haiti) right footed shot.')).toBeUndefined();
    expect(classifyCommentary('Attempt missed. Jean-Ricner Bellegarde (Haiti) right footed shot.')).toBeUndefined();
    expect(classifyCommentary('Goal! Brazil 2, Haiti 0. Matheus Cunha (Brazil) left footed shot.')).toBeUndefined();
    expect(classifyCommentary('Header from six yards, forces a save!')).toBeUndefined();
  });

  it('classifyResolverCommentary maps taken/saved set-pieces for settlement', async () => {
    const { classifyResolverCommentary } = await import('../ai/marketTuning');
    expect(classifyResolverCommentary('Attempt saved. Hakan Çalhanoğlu (Türkiye) right footed shot.')).toBe('miss');
    expect(
      classifyResolverCommentary('Hakan Çalhanoğlu (Türkiye) plays a short pass from the free kick.'),
    ).toBe('play_end');
    expect(classifyResolverCommentary('Türkiye hit the wall from the free kick.')).toBe('play_end');
    expect(classifyResolverCommentary('Goal! Brazil 1-0 from open play.')).toBeUndefined();
  });

  it('captures live attacking phrasings that used to slip through', () => {
    expect(classifyCommentary('A clear chance opens up for Kane.')).toBe('dangerous_attack');
    expect(classifyCommentary('The rebound falls to Saka in the box!')).toBe('dangerous_attack');
    expect(classifyCommentary('Cut-back into the danger zone.')).toBe('dangerous_attack');
    expect(classifyCommentary('Brazil surging forward in the final third.')).toBe('attack');
    expect(classifyCommentary('Haiti pushing forward on the attack.')).toBe('attack');
  });

  it('does NOT open on bare fouls (those become FK markets, not card markets)', () => {
    expect(classifyCommentary('Foul by Raphinha (Brazil).')).toBeUndefined();
  });

  it('ignores non-events', () => {
    expect(classifyCommentary('Throw-in, recycled at the back.')).toBeUndefined();
    expect(classifyCommentary('Lineups are announced.')).toBeUndefined();
  });

  it('opens a VAR review for a possible red card (card markets only under VAR)', () => {
    expect(classifyCommentary('VAR review for a possible red card — violent conduct.')).toBe(
      'var_check',
    );
    expect(classifyCommentary('The referee is checking the pitchside monitor for a sending off.')).toBe(
      'var_check',
    );
    // an instant card with no VAR is NOT a market
    expect(classifyCommentary('Yellow card shown to Raphinha for a late challenge.')).toBeUndefined();
  });

  it('treats a VAR card DECISION as a review opener, not a penalty-denied resolver', () => {
    // Regression: "VAR Decision: No card change …" used to match the penalty-denied
    // resolver (var decision…no) and was swallowed — so the RED-card market the
    // moment deserved never opened. It must classify as a var_check.
    expect(classifyCommentary('VAR Decision: No card change Miguel Almirón (Paraguay).')).toBe(
      'var_check',
    );
    // A genuine penalty denial still resolves a penalty market NO.
    expect(classifyCommentary('VAR overturns the penalty — no penalty given.')).toBe(
      'var_penalty_denied',
    );
  });

  it('detects Spanish ESPN build-up and set-pieces (Brazil/Haiti)', () => {
    expect(
      classifyCommentary('Gabriel Magalhães (Brasil) ha recibido una falta en campo contrario.'),
    ).toBe('free_kick');
    expect(classifyCommentary('Remate parado por bajo a la izquierda. Raphinha (Brasil) remate.')).toBeUndefined();
    expect(
      classifyCommentary(
        'Fuera de juego, Brasil. Lucas Paquetá intentó un pase en profundidad pero Matheus Cunha estaba en posición de fuera de juego.',
      ),
    ).toBeUndefined();
    expect(classifyCommentary('Brasil presión ofensiva en zona ofensiva.')).toBe('attack');
  });
});

describe('parseAwardedTeamFromCommentary — correct side on set-pieces', () => {
  it('awards the corner to the named team, not the conceding side', () => {
    expect(
      parseAwardedTeamFromCommentary('Corner, Scotland. Conceded by Jack Hendry.', 'Scotland', 'Morocco'),
    ).toBe('home');
    expect(
      parseAwardedTeamFromCommentary('Corner, Morocco. Conceded by Kieran Tierney.', 'Scotland', 'Morocco'),
    ).toBe('away');
  });

  it('parses Spanish free-kick awards from parenthetical team name', () => {
    expect(
      parseAwardedTeamFromCommentary(
        'Gabriel Magalhães (Brasil) ha recibido una falta en campo contrario.',
        'Brazil',
        'Haiti',
      ),
    ).toBe('home');
  });
});

describe('EspnFeed.poll — dedupes commentary/keyEvent twins', () => {
  const scoreboard = {
    events: [
      {
        id: 'e1',
        status: { type: { state: 'in' }, displayClock: "50'" },
        competitions: [
          {
            competitors: [
              { homeAway: 'home', score: '0', team: { id: 'sco', displayName: 'Scotland', abbreviation: 'SCO' } },
              { homeAway: 'away', score: '1', team: { id: 'mar', displayName: 'Morocco', abbreviation: 'MAR' } },
            ],
          },
        ],
      },
    ],
  };
  const summary = {
    keyEvents: [
      { sequence: 10, clock: { displayValue: "50'" }, type: { text: 'Corner' }, text: 'Corner', team: { id: 'sco' } },
    ],
    commentary: [{ sequence: 11, time: { displayValue: "50'" }, text: 'Corner, Scotland. Conceded by Grant Hanley.' }],
  };

  it('emits only one corner market moment when both sources agree', async () => {
    const fetchImpl = (async (url: string) =>
      ({ ok: true, status: 200, json: async () => (String(url).includes('/summary') ? summary : scoreboard) }) as Response) as unknown as typeof fetch;

    const feed = new EspnFeed({ league: 'fifa.world', fetchImpl, replayHistory: true, commentaryLang: 'en' });
    expect(await feed.start()).toBe(true);
    const events = await feed.poll(Date.now());
    const corners = events.filter((e) => e.type === 'corner');
    expect(corners).toHaveLength(1);
    expect(corners[0].meta?.source).toBe('espn.keyEvent');
  });
});

describe('EspnFeed.rotateToNextLive — game-to-game handoff', () => {
  it('rotates from a final match to the next live fixture', async () => {
    const liveOld = {
      events: [
        {
          id: 'old',
          status: { type: { state: 'in' }, displayClock: "88'" },
          competitions: [
            {
              competitors: [
                { homeAway: 'home', score: '2', team: { id: 'bra', displayName: 'Brazil', abbreviation: 'BRA' } },
                { homeAway: 'away', score: '0', team: { id: 'hai', displayName: 'Haiti', abbreviation: 'HAI' } },
              ],
            },
          ],
        },
      ],
    };
    const scoreboardFinal = {
      events: [
        {
          id: 'old',
          status: { type: { state: 'post', completed: true }, displayClock: "90'" },
          competitions: liveOld.events[0].competitions,
        },
        {
          id: 'new',
          status: { type: { state: 'in' }, displayClock: "12'" },
          competitions: [
            {
              competitors: [
                { homeAway: 'home', score: '0', team: { id: 'eng', displayName: 'England', abbreviation: 'ENG' } },
                { homeAway: 'away', score: '0', team: { id: 'fra', displayName: 'France', abbreviation: 'FRA' } },
              ],
            },
          ],
        },
      ],
    };

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const board = calls === 1 ? liveOld : scoreboardFinal;
      return { ok: true, status: 200, json: async () => board } as Response;
    }) as unknown as typeof fetch;

    const feed = new EspnFeed({ league: 'fifa.world', fetchImpl, replayHistory: true, commentaryLang: 'en' });
    await feed.start();
    (feed as unknown as { game: { state: GameState } }).game.state.status = 'final';

    expect(feed.shouldRotate()).toBe(true);
    expect(await feed.rotateToNextLive()).toBe(true);
    expect(feed.state().home.name).toBe('England');
    expect(feed.currentEventId()).toBe('new');
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
    expect(mapKeyEventType({ type: { text: 'Yellow Card' } })).toBe('yellow_card');
    expect(mapKeyEventType({ type: { text: 'Tarjeta amarilla' } })).toBe('yellow_card');
    expect(mapKeyEventType({ type: { text: 'Substitution' } })).toBeUndefined();
    expect(mapKeyEventType({ scoringPlay: true, type: { text: 'Gol' } })).toBe('goal');
  });
  it('does NOT open a corner market from vague "corner" prose', () => {
    expect(
      mapKeyEventType({ type: { text: 'Play' }, text: 'cleared from the corner of the six yard box' }),
    ).toBeUndefined();
    expect(mapKeyEventType({ type: { text: 'Corner' }, text: 'Corner' })).toBe('corner');
    expect(mapKeyEventType({ type: { text: 'Other' }, text: 'Corner, Brazil. Conceded by X.' })).toBe(
      'corner',
    );
  });
});

describe('EspnFeed.poll — goal team from prose when ESPN omits team id', () => {
  it('attributes a goal to home when the scorer is named in text', async () => {
    const summary = {
      keyEvents: [
        {
          sequence: 99,
          clock: { displayValue: "34'" },
          scoringPlay: true,
          type: { text: 'Goal' },
          text: 'Goal! Brazil take the lead.',
        },
      ],
    };
    const scoreboard = {
      events: [
        {
          id: 'e1',
          status: { type: { state: 'in' }, displayClock: "34'" },
          competitions: [
            {
              competitors: [
                { homeAway: 'home', score: '1', team: { id: 'bra', displayName: 'Brazil', abbreviation: 'BRA' } },
                { homeAway: 'away', score: '0', team: { id: 'hai', displayName: 'Haiti', abbreviation: 'HAI' } },
              ],
            },
          ],
        },
      ],
    };
    const fetchImpl = (async (url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/summary') ? summary : scoreboard),
      }) as Response) as unknown as typeof fetch;

    const feed = new EspnFeed({ league: 'fifa.world', fetchImpl, replayHistory: true, commentaryLang: 'en' });
    await feed.start();
    const events = await feed.poll(Date.now());
    const goal = events.find((e) => e.type === 'goal');
    expect(goal?.team).toBe('home');
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

describe('momentKey — set-piece dedupe', () => {
  const fk = (clock: string): FeedEvent => ({
    gameId: 'g1',
    ts: 1,
    type: 'free_kick',
    team: 'home',
    text: 'FK',
    meta: { clock, source: 'espn.keyEvent' },
  });

  it('buckets set-pieces by regulation minute only', () => {
    expect(momentKey(fk("4'"))).toBe('free_kick:home:4');
    expect(momentKey(fk("4+1'"))).toBe('free_kick:home:4');
  });

  it('keeps stoppage for open-play moments', () => {
    const atk = (clock: string): FeedEvent => ({
      gameId: 'g1',
      ts: 1,
      type: 'attack',
      team: 'home',
      text: 'pushing forward',
      meta: { clock },
    });
    expect(momentKey(atk("45'"))).toBe('attack:home:45+0');
    expect(momentKey(atk("45+2'"))).toBe('attack:home:45+2');
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

    const feed = new EspnFeed({ league: 'fifa.world', fetchImpl, replayHistory: true, commentaryLang: 'en' });
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
