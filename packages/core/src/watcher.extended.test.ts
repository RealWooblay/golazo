import { describe, expect, it } from 'vitest';
import { outcomeFromEvent, triggerFromEvent } from './watcher';

describe('extended market resolution', () => {
  const ev = (type: string, team?: 'home' | 'away') => ({
    gameId: 'g1',
    ts: 1,
    type: type as never,
    text: 'x',
    ...(team ? { team } : {}),
  });

  it('VAR penalty market resolves YES on a penalty award (NO comes from the deadline)', () => {
    expect(outcomeFromEvent(ev('penalty'), 'penalty_awarded')).toBe('YES');
    // An event can only ever cause YES — a denial settles NO via the deadline sweep.
    expect(outcomeFromEvent(ev('var_penalty_denied'), 'penalty_awarded')).toBe(null);
    expect(outcomeFromEvent(ev('goal'), 'penalty_awarded')).toBe(null);
  });

  const varEvent = (text: string) => ({ gameId: 'g1', ts: 1, type: 'var_check' as never, text });

  it('VAR penalty review opens a penalty market', () => {
    const t = triggerFromEvent(varEvent('VAR check for a possible penalty, handball in the box.'));
    expect(t?.kind).toBe('penalty_awarded');
    expect(t?.question).toMatch(/VAR check.*penalty/i);
  });

  it('VAR red-card review opens a RED card market (cards ARE bettable under VAR)', () => {
    const t = triggerFromEvent(varEvent('VAR review for a possible red card — violent conduct.'));
    expect(t?.kind).toBe('red_card_given');
    expect(t?.question).toMatch(/VAR check.*red card/i);
    expect(t?.team).toBeUndefined(); // teamless: "will THIS review produce a red?"
  });

  it('a generic VAR CARD decision routes to the red-card market, not penalty', () => {
    // ESPN's real "VAR Decision: No card change …" line — a card review, no penalty.
    const t = triggerFromEvent(varEvent('VAR Decision: No card change Miguel Almirón (Paraguay).'));
    expect(t?.kind).toBe('red_card_given');
  });

  it('penalty wins when a VAR review mentions BOTH a card and a penalty', () => {
    const t = triggerFromEvent(varEvent('VAR check: possible penalty and a card for the foul.'));
    expect(t?.kind).toBe('penalty_awarded');
  });

  it('VAR red-card market resolves YES when a red card is actually shown', () => {
    expect(outcomeFromEvent(ev('red_card', 'home'), 'red_card_given')).toBe('YES');
    // it does NOT settle on anything else — it waits for the real card (no blind NO)
    expect(outcomeFromEvent(ev('yellow_card', 'home'), 'red_card_given')).toBe(null);
    expect(outcomeFromEvent(ev('goal', 'home'), 'red_card_given')).toBe(null);
  });

  it('NEVER opens INSTANT card markets — only VAR-gated ones', () => {
    expect(triggerFromEvent(ev('card_incident', 'away'), { awayName: 'Morocco' })).toBeNull();
    expect(triggerFromEvent(ev('red_card_incident', 'home'), { homeName: 'Scotland' })).toBeNull();
  });

  it('events never settle a goal market NO — only the deadline sweep does', () => {
    // ONE RULE: an event can only ever cause YES. A play_end / non-goal shot no
    // longer pre-empts a genuinely-late goal that arrives in a later poll.
    expect(outcomeFromEvent(ev('play_end'), 'goal_from_free_kick')).toBe(null);
    expect(outcomeFromEvent(ev('shot'), 'goal_from_free_kick')).toBe(null);
    expect(outcomeFromEvent(ev('shot'), 'goal_from_open_play')).toBe(null);
    expect(outcomeFromEvent(ev('goal'), 'goal_from_free_kick')).toBe('YES');
  });

  describe('no team → no market (never render "They …")', () => {
    it('drops team-bound triggers with no team', () => {
      expect(triggerFromEvent(ev('free_kick'))).toBeNull();
      expect(triggerFromEvent(ev('corner'))).toBeNull();
      expect(triggerFromEvent(ev('dangerous_attack'))).toBeNull();
      expect(triggerFromEvent(ev('penalty'))).toBeNull();
    });

    it('still opens teamless VAR-review markets', () => {
      expect(triggerFromEvent(ev('var_check'))?.kind).toBe('penalty_awarded');
    });

    it('opens team-bound triggers when a team is present', () => {
      expect(triggerFromEvent(ev('free_kick', 'home'))?.kind).toBe('goal_from_free_kick');
    });
  });

  describe('PHASE 2 — new deterministic window kinds (YES-on-event, NO-on-deadline)', () => {
    it('shot_or_corner_in_window resolves YES on a shot/miss/goal OR a corner, else null', () => {
      expect(outcomeFromEvent(ev('goal', 'home'), 'shot_or_corner_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('shot', 'home'), 'shot_or_corner_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('miss', 'home'), 'shot_or_corner_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('corner', 'home'), 'shot_or_corner_in_window')).toBe('YES');
      // a non-qualifying event NEVER settles NO — the deadline sweep does
      expect(outcomeFromEvent(ev('free_kick', 'home'), 'shot_or_corner_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('yellow_card', 'home'), 'shot_or_corner_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('play_end', 'home'), 'shot_or_corner_in_window')).toBe(null);
    });

    it('card_in_window resolves YES on any booking (yellow/red/card), else null', () => {
      expect(outcomeFromEvent(ev('yellow_card', 'home'), 'card_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('red_card', 'away'), 'card_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('card', 'home'), 'card_in_window')).toBe('YES');
      // not a booking → no opinion (NO comes only from the deadline sweep)
      expect(outcomeFromEvent(ev('goal', 'home'), 'card_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('foul' as never, 'home'), 'card_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('corner', 'home'), 'card_in_window')).toBe(null);
    });

    it('goal_in_window resolves YES on a goal (either team), else null', () => {
      expect(outcomeFromEvent(ev('goal', 'home'), 'goal_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('goal', 'away'), 'goal_in_window')).toBe('YES');
      expect(outcomeFromEvent(ev('shot', 'home'), 'goal_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('miss', 'home'), 'goal_in_window')).toBe(null);
      expect(outcomeFromEvent(ev('corner', 'home'), 'goal_in_window')).toBe(null);
    });

    it('over_corners / over_shots never settle from a single event (the COUNTER decides)', () => {
      // Count kinds are settled by the orchestrator's running counter crossing the line,
      // NOT a lone event — outcomeFromEvent can't see N, so it always returns null here.
      expect(outcomeFromEvent(ev('corner', 'home'), 'over_corners')).toBe(null);
      expect(outcomeFromEvent(ev('goal', 'home'), 'over_corners')).toBe(null);
      expect(outcomeFromEvent(ev('shot', 'home'), 'over_shots')).toBe(null);
      expect(outcomeFromEvent(ev('miss', 'home'), 'over_shots')).toBe(null);
      expect(outcomeFromEvent(ev('goal', 'home'), 'over_shots')).toBe(null);
    });

    it('no new kind EVER returns NO from an event (one-NO-writer invariant)', () => {
      const kinds = [
        'shot_or_corner_in_window',
        'card_in_window',
        'goal_in_window',
        'over_corners',
        'over_shots',
      ];
      const types = [
        'goal',
        'shot',
        'miss',
        'corner',
        'free_kick',
        'penalty',
        'yellow_card',
        'red_card',
        'card',
        'play_end',
        'var_check',
        'halftime',
      ];
      for (const k of kinds) {
        for (const tp of types) {
          const out = outcomeFromEvent(ev(tp, 'home'), k);
          expect(out === 'YES' || out === null).toBe(true);
        }
      }
    });
  });

  describe('chance_from_play — "on this play" possession market', () => {
    it('resolves YES on any shot/goal during the move', () => {
      expect(outcomeFromEvent(ev('goal', 'home'), 'chance_from_play')).toBe('YES');
      expect(outcomeFromEvent(ev('shot', 'home'), 'chance_from_play')).toBe('YES');
      // a shot that misses/is saved is still "a shot this move" → YES
      expect(outcomeFromEvent(ev('miss', 'home'), 'chance_from_play')).toBe('YES');
    });

    it('does NOT settle from a play_end event — a fizzled move settles NO via the deadline', () => {
      // NO is written in exactly one place (the deadline sweep), never from an event.
      expect(outcomeFromEvent(ev('play_end', 'home'), 'chance_from_play')).toBe(null);
    });

    it('open-play attack triggers open this fast market kind', () => {
      expect(triggerFromEvent(ev('attack', 'home'), { homeName: 'Türkiye' })?.kind).toBe(
        'chance_from_play',
      );
      expect(triggerFromEvent(ev('dangerous_attack', 'away'), { awayName: 'Spain' })?.kind).toBe(
        'chance_from_play',
      );
    });
  });
});
