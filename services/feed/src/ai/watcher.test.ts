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

  it('CONFIDENCE GATE: bettable but LOW confidence → no market', async () => {
    judge = new RecordingJudge(decision({ confidence: 0.3 })); // e.g. a vague midfield attack
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull(); // below minConfidence (0.6) → skipped
  });

  it('free-kick judged NOT dangerous (e.g. own half) → no market', async () => {
    judge = new RecordingJudge(decision({ bettable: false, confidence: 0.1 }));
    const t = await aiTriggerFromEvents([ev('free_kick', 'Free kick in their own half')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull();
  });

  it('FUZZY + judge=null (no key) → SKIP, not a junk rules market', async () => {
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge: null });
    expect(t).toBeNull();
  });

  it('FUZZY + judge throws → no market (never guess on a failed judgement)', async () => {
    judge = new RecordingJudge(null, true);
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(judge.calls).toBe(1);
    expect(t).toBeNull();
  });

  it('FUZZY + confident but thin text → backfills question/kind from rules', async () => {
    judge = new RecordingJudge(decision({ question: '   ', kind: '' }));
    const t = await aiTriggerFromEvents([ev('dangerous_attack')], GAME, CTX, { judge });
    expect(t).not.toBeNull();
    expect(t!.question.length).toBeGreaterThan(0);
    expect(t!.kind).toBe('goal_from_open_play');
  });
});
