import { describe, expect, it } from 'vitest';
import { outcomeFromEvent, kindSettlesNoOnTimeout, triggerFromEvent } from './watcher';

describe('extended market resolution', () => {
  const ev = (type: string, team?: 'home' | 'away') => ({
    gameId: 'g1',
    ts: 1,
    type: type as never,
    text: 'x',
    ...(team ? { team } : {}),
  });

  it('VAR penalty market resolves on penalty award or denial', () => {
    expect(outcomeFromEvent(ev('penalty'), 'penalty_awarded')).toBe('YES');
    expect(outcomeFromEvent(ev('var_penalty_denied'), 'penalty_awarded')).toBe('NO');
    expect(outcomeFromEvent(ev('goal'), 'penalty_awarded')).toBe(null);
  });

  const varEvent = (text: string) => ({ gameId: 'g1', ts: 1, type: 'var_check' as never, text });

  it('VAR penalty review opens a penalty market', () => {
    const t = triggerFromEvent(varEvent('VAR check for a possible penalty, handball in the box.'));
    expect(t?.kind).toBe('penalty_awarded');
    expect(t?.question).toMatch(/VAR review.*penalty be awarded/i);
  });

  it('VAR red-card review opens a RED card market (cards ARE bettable under VAR)', () => {
    const t = triggerFromEvent(varEvent('VAR review for a possible red card — violent conduct.'));
    expect(t?.kind).toBe('red_card_given');
    expect(t?.question).toMatch(/VAR review.*RED card/i);
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

  it('kindSettlesNoOnTimeout covers VAR + play markets, never goal questions', () => {
    expect(kindSettlesNoOnTimeout('penalty_awarded')).toBe(true);
    expect(kindSettlesNoOnTimeout('red_card_given')).toBe(true);
    expect(kindSettlesNoOnTimeout('chance_from_play')).toBe(true);
    expect(kindSettlesNoOnTimeout('goal_from_free_kick')).toBe(false);
    expect(kindSettlesNoOnTimeout('goal_from_open_play')).toBe(false);
    expect(kindSettlesNoOnTimeout('penalty_scored')).toBe(false);
  });

  it('play_end and set-piece shot resolve goal markets', () => {
    expect(outcomeFromEvent(ev('play_end'), 'goal_from_free_kick')).toBe('NO');
    expect(outcomeFromEvent(ev('shot'), 'goal_from_free_kick')).toBe('NO');
    expect(outcomeFromEvent(ev('shot'), 'goal_from_open_play')).toBe(null);
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

  describe('chance_from_play — "on this play" possession market', () => {
    it('resolves YES on any shot/goal during the move', () => {
      expect(outcomeFromEvent(ev('goal', 'home'), 'chance_from_play')).toBe('YES');
      expect(outcomeFromEvent(ev('shot', 'home'), 'chance_from_play')).toBe('YES');
      // a shot that misses/is saved is still "a shot this move" → YES
      expect(outcomeFromEvent(ev('miss', 'home'), 'chance_from_play')).toBe('YES');
    });

    it('resolves NO when the play ends (possession lost / cleared)', () => {
      expect(outcomeFromEvent(ev('play_end', 'home'), 'chance_from_play')).toBe('NO');
    });

    it('settles NO on the countdown timer (a fizzled move = no shot)', () => {
      expect(kindSettlesNoOnTimeout('chance_from_play')).toBe(true);
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
