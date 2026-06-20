import { describe, it, expect, beforeEach } from 'vitest';
import type { FeedEvent, GameState } from '@golazo/core';
import { aiTriggerFromEvents, tierOf, type MarketJudge, type MarketDecision } from './watcher';

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

/** Build a judge decision; confident + bettable by default. */
function decision(over: Partial<MarketDecision> = {}): MarketDecision {
  return { bettable: true, confidence: 0.85, question: 'Q?', kind: 'goal_from_open_play', trueProb: 0.3, ...over };
}

/** A judge that records how many times it was asked, and what to answer. */
class RecordingJudge implements MarketJudge {
  calls = 0;
  constructor(
    private answer: MarketDecision | null,
    private shouldThrow = false,
  ) {}
  async judge(): Promise<MarketDecision | null> {
    this.calls++;
    if (this.shouldThrow) throw new Error('api down');
    return this.answer;
  }
}

describe('tierOf — cost routing', () => {
  it('penalty / corner → rules tier (inherently attacking, no LLM)', () => {
    expect(tierOf('penalty')).toBe('set_piece');
    expect(tierOf('corner')).toBe('set_piece');
  });
  it('free-kick + open-play → fuzzy tier (danger depends on context → LLM judges)', () => {
    expect(tierOf('free_kick')).toBe('fuzzy'); // a free-kick can be defensive!
    expect(tierOf('dangerous_attack')).toBe('fuzzy');
    expect(tierOf('attack')).toBe('fuzzy');
  });
  it('ignores resolutions / noise', () => {
    for (const t of ['goal', 'miss', 'card', 'calm', 'kickoff', 'final'] as const) {
      expect(tierOf(t)).toBe('ignore');
    }
  });
});

describe('aiTriggerFromEvents — tiering, confidence gate, fallback', () => {
  let judge: RecordingJudge;
  beforeEach(() => {
    judge = new RecordingJudge(decision());
  });

  it('SET-PIECE (penalty) opens via rules and NEVER calls the judge', async () => {
    const t = await aiTriggerFromEvents([ev('penalty')], GAME, CTX, { judge });
    expect(judge.calls).toBe(0);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('penalty_scored');
    expect(t!.question).toMatch(/England/);
  });

  it('STRUCTURED keyEvent free_kick in an attacking zone opens instantly without judge', async () => {
    const fk = {
      ...ev('free_kick', 'Free kick in the attacking third.'),
      meta: { source: 'espn.keyEvent' as const },
    };
    const t = await aiTriggerFromEvents([fk], GAME, CTX, { judge });
    expect(judge.calls).toBe(0);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('goal_from_free_kick');
  });

  it('bare keyEvent free_kick with no location defers to the AI judge (no blind open)', async () => {
    const fk = {
      ...ev('free_kick', 'Foul by Croatia'),
      meta: { source: 'espn.keyEvent' as const },
    };
    judge = new RecordingJudge(decision({ bettable: false, confidence: 0.1 }));
    const t = await aiTriggerFromEvents([fk], GAME, CTX, { judge });
    expect(judge.calls).toBe(1); // judged, not instantly opened
    expect(t).toBeNull();
  });

  it('STRUCTURED keyEvent corner opens instantly without judge', async () => {
    const corner = {
      ...ev('corner', 'Corner, England'),
      meta: { source: 'espn.keyEvent' as const },
    };
    const t = await aiTriggerFromEvents([corner], GAME, CTX, { judge });
    expect(judge.calls).toBe(0);
    expect(t!.kind).toBe('goal_from_corner');
  });

  it('IGNORE events never open and never call the judge', async () => {
    for (const type of ['goal', 'miss', 'calm'] as const) {
      expect(await aiTriggerFromEvents([ev(type)], GAME, CTX, { judge })).toBeNull();
    }
    expect(judge.calls).toBe(0);
  });

  it('FUZZY + confident bettable decision → opens', async () => {
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).not.toBeNull();
    expect(t!.question).toBe('Q?');
    expect(t!.team).toBe('home');
  });

  it('CONFIDENCE GATE: bettable but LOW confidence → no rules fallback for dangerous_attack', async () => {
    judge = new RecordingJudge(decision({ confidence: 0.3 }));
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull();
  });

  it('CONFIDENCE GATE: very low confidence (own-half/backwards) → still skipped', async () => {
    // The open-play bar is LOW now (we want frequent markets), but genuinely
    // non-forward play still scores below it and never opens.
    judge = new RecordingJudge(decision({ confidence: 0.2 }));
    const t = await aiTriggerFromEvents([ev('attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull();
  });

  it('LOW BAR: medium-confidence forward play now OPENS a chance_from_play market', async () => {
    judge = new RecordingJudge(decision({ confidence: 0.4 }));
    const t = await aiTriggerFromEvents([ev('attack')], GAME, CTX, { judge });
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('chance_from_play');
  });

  it('own-half free-kick → skipped deterministically, never spends AI', async () => {
    judge = new RecordingJudge(decision({ bettable: true, confidence: 0.9 }));
    const t = await aiTriggerFromEvents(
      [ev('free_kick', 'Paraguay wins a free kick in their own half')],
      GAME,
      CTX,
      { judge },
    );
    expect(judge.calls).toBe(0); // defensive set-piece filtered before the model
    expect(t).toBeNull();
  });

  it('no team → no market, even when the AI judges it bettable (never "They …")', async () => {
    judge = new RecordingJudge(decision({ bettable: true, confidence: 0.9 }));
    const teamless: FeedEvent = { gameId: 'g1', ts: 0, type: 'dangerous_attack', text: 'Dangerous break' };
    const t = await aiTriggerFromEvents([teamless], GAME, CTX, { judge });
    expect(t).toBeNull();
  });

  it('FUZZY dangerous_attack + AI unavailable (no key) → opens via rules, never goes dark', async () => {
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge: null });
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('chance_from_play');
  });

  it('FUZZY dangerous_attack + judge TIMEOUT → opens via rules fallback', async () => {
    judge = new RecordingJudge(null); // returns null → treated as timeout
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('chance_from_play');
  });

  it('FUZZY dangerous_attack + judge EXPLICITLY not bettable → respects AI, no market', async () => {
    judge = new RecordingJudge(decision({ bettable: false, confidence: 0.1 }));
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull();
  });

  it('awarded free kick commentary opens instantly without judge', async () => {
    const fk = ev('free_kick', 'Matheus Cunha (Brazil) wins a free kick in the attacking half.');
    const t = await aiTriggerFromEvents([fk], GAME, CTX, { judge: null });
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('goal_from_free_kick');
  });

  it('momentum attack opens via rules when AI unavailable', async () => {
    const t = await aiTriggerFromEvents(
      [ev('attack', 'Brazil surging forward in the final third.')],
      GAME,
      CTX,
      { judge: null },
    );
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('chance_from_play');
  });

  it('post-shot dangerous_attack never opens even with rules fallback', async () => {
    const postShot = ev(
      'dangerous_attack',
      'Attempt saved. Vinícius Júnior (Brazil) right footed shot from the centre of the box.',
    );
    const t = await aiTriggerFromEvents([postShot], GAME, CTX, { judge: null });
    expect(t).toBeNull();
  });

  it('commentary free_kick without key → needs judge; null judge skips', async () => {
    const t = await aiTriggerFromEvents(
      [ev('free_kick', 'Free kick in the attacking half')],
      GAME,
      CTX,
      { judge: null },
    );
    expect(t).toBeNull();
  });

  it('FUZZY + judge throws → momentum attack still opens via rules', async () => {
    judge = new RecordingJudge(null, true);
    const t = await aiTriggerFromEvents(
      [ev('attack', 'Haiti pushing forward on the attack.')],
      GAME,
      CTX,
      { judge },
    );
    expect(judge.calls).toBe(1);
    expect(t).not.toBeNull();
  });

  it('FUZZY + confident but thin text → backfills question/kind from rules', async () => {
    judge = new RecordingJudge(decision({ question: '   ', kind: '' }));
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(t).not.toBeNull();
    expect(t!.question.length).toBeGreaterThan(0);
    expect(t!.kind).toBe('chance_from_play');
  });
});
