import { describe, it, expect } from 'vitest';
import type { FeedEvent, GameState } from '@golazo/core';
import { aiTriggerFromEvents, tierOf } from './watcher';

const GAME: GameState = {
  gameId: 'g1',
  sport: 'soccer',
  league: 'FIFA World Cup',
  home: { id: 'eng', name: 'England', abbr: 'ENG' },
  away: { id: 'cro', name: 'Croatia', abbr: 'CRO' },
  scoreHome: 1,
  scoreAway: 1,
  clock: "30'",
  status: 'live',
};
const CTX = { homeName: 'England', awayName: 'Croatia' };

function ev(type: FeedEvent['type'], text = 'x', team: FeedEvent['team'] = 'home'): FeedEvent {
  return { gameId: 'g1', ts: 0, type, team, text };
}

describe('tierOf — cost routing (set-piece rules only)', () => {
  it('penalty / corner / free kick / var → set-piece tier (just open it, no LLM)', () => {
    expect(tierOf('penalty')).toBe('set_piece');
    expect(tierOf('corner')).toBe('set_piece');
    expect(tierOf('free_kick')).toBe('set_piece');
    expect(tierOf('var_check')).toBe('set_piece');
  });
  it('open-play and resolutions / noise are ignored (no fuzzy AI path)', () => {
    for (const t of ['attack', 'dangerous_attack', 'goal', 'miss', 'calm', 'kickoff', 'final'] as const) {
      expect(tierOf(t)).toBe('ignore');
    }
  });
});

describe('aiTriggerFromEvents — delayed-feed launch behavior', () => {
  it('does not open set-piece markets while SET_PIECES_ENABLED is off', async () => {
    const t = await aiTriggerFromEvents([ev('penalty')], GAME, CTX);
    expect(t).toBeNull();
  });

  it('does not open structured free_kick keyEvents while set pieces are disabled', async () => {
    const fk = {
      ...ev('free_kick', 'Free kick in the attacking third.'),
      meta: { source: 'espn.keyEvent' as const },
    };
    const t = await aiTriggerFromEvents([fk], GAME, CTX);
    expect(t).toBeNull();
  });

  it('does not open structured corner keyEvents while set pieces are disabled', async () => {
    const corner = {
      ...ev('corner', 'Corner, England'),
      meta: { source: 'espn.keyEvent' as const },
    };
    const t = await aiTriggerFromEvents([corner], GAME, CTX);
    expect(t).toBeNull();
  });

  it('IGNORE events never open (open-play is no longer an opener here)', async () => {
    for (const type of ['goal', 'miss', 'calm', 'attack', 'dangerous_attack'] as const) {
      expect(await aiTriggerFromEvents([ev(type)], GAME, CTX)).toBeNull();
    }
  });

  it('own-half / defensive free-kick → skipped deterministically', async () => {
    const t = await aiTriggerFromEvents(
      [ev('free_kick', 'Paraguay wins a free kick in their own half')],
      GAME,
      CTX,
    );
    expect(t).toBeNull();
  });

  it('does not open awarded free kick commentary while set pieces are disabled', async () => {
    const fk = ev('free_kick', 'Matheus Cunha (Brazil) wins a free kick in the attacking half.');
    const t = await aiTriggerFromEvents([fk], GAME, CTX);
    expect(t).toBeNull();
  });

  it('post-shot lines never open', async () => {
    const postShot = ev(
      'free_kick',
      'Attempt saved. Vinícius Júnior (Brazil) right footed shot from the centre of the box.',
    );
    const t = await aiTriggerFromEvents([postShot], GAME, CTX);
    expect(t).toBeNull();
  });

  it('no team → no team-bound market (never render "They …")', async () => {
    const teamless: FeedEvent = { gameId: 'g1', ts: 0, type: 'corner', text: 'Corner' };
    const t = await aiTriggerFromEvents([teamless], GAME, CTX);
    expect(t).toBeNull();
  });

  it('does not open VAR review markets while set pieces are disabled', async () => {
    const varEv: FeedEvent = {
      gameId: 'g1',
      ts: 0,
      type: 'var_check',
      text: 'VAR check for a possible penalty, handball in the box.',
    };
    const t = await aiTriggerFromEvents([varEv], GAME, CTX);
    expect(t).toBeNull();
  });
});
