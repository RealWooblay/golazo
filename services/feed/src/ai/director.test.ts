import { describe, it, expect } from 'vitest';
import type { GameState } from '@golazo/core';
import { validateProposal, DIRECTOR_PALETTE, MarketDirector } from './director';
import type { CommentaryBuffer } from './commentaryBuffer';

const game = (): GameState => ({
  gameId: 'g1',
  sport: 'soccer',
  league: 'WC',
  home: { id: 'bra', name: 'Brazil', abbr: 'BRA' },
  away: { id: 'arg', name: 'Argentina', abbr: 'ARG' },
  scoreHome: 1,
  scoreAway: 0,
  clock: "30'",
  status: 'live',
});

const NOW = 1_000_000;

describe('MarketDirector.validateProposal — the palette validation wall', () => {
  it('accepts a well-formed team-bound proposal and derives the slot', () => {
    const p = validateProposal(
      { kind: 'next_shot', team: 'home', question: 'Who threatens next — Brazil or Argentina?', trueProb: 0.5, windowMs: 10_000, relevance: 0.8 },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('next_shot');
    expect(p!.slot).toBe('versus');
    expect(p!.team).toBe('home');
    expect(p!.bornAt).toBe(NOW);
  });

  it('accepts a teamless either-team proposal', () => {
    const p = validateProposal(
      { kind: 'goal_in_window', question: 'A goal by either side in the next few minutes?', trueProb: 0.3, windowMs: 9_000, relevance: 0.6 },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.team).toBeUndefined();
  });

  it('REJECTS an off-palette kind (the AI can never invent a kind)', () => {
    expect(DIRECTOR_PALETTE.has('penalty_scored')).toBe(false);
    expect(
      validateProposal(
        { kind: 'penalty_scored', team: 'home', question: 'Brazil to score the penalty?', trueProb: 0.8, windowMs: 10_000, relevance: 1 },
        game(),
        NOW,
      ),
    ).toBeNull();
    expect(validateProposal({ kind: 'made_up_kind', question: 'Anything?', trueProb: 0.5, windowMs: 10_000 }, game(), NOW)).toBeNull();
  });

  it('REJECTS a team-bound kind with no/invalid team, and a teamless kind that carries a team', () => {
    // shot_in_window needs a team.
    expect(validateProposal({ kind: 'shot_in_window', question: 'Brazil to get a shot away this spell?', trueProb: 0.4, windowMs: 10_000 }, game(), NOW)).toBeNull();
    expect(validateProposal({ kind: 'shot_in_window', team: 'nobody', question: 'Brazil to get a shot away?', trueProb: 0.4, windowMs: 10_000 }, game(), NOW)).toBeNull();
    // over_corners must NOT carry a team.
    expect(validateProposal({ kind: 'over_corners', team: 'home', question: 'More corners than the line soon?', trueProb: 0.5, windowMs: 10_000 }, game(), NOW)).toBeNull();
  });

  it('REJECTS a question with ANY digit (blocks fabricated scores/clocks)', () => {
    expect(
      validateProposal(
        { kind: 'shot_in_window', team: 'home', question: 'Brazil 2 Argentina 0 — a shot this spell?', trueProb: 0.4, windowMs: 10_000 },
        game(),
        NOW,
      ),
    ).toBeNull();
  });

  it('REJECTS a team-bound question that does not name the team', () => {
    expect(
      validateProposal(
        { kind: 'shot_in_window', team: 'home', question: 'A shot away this spell?', trueProb: 0.4, windowMs: 10_000 },
        game(),
        NOW,
      ),
    ).toBeNull();
  });

  it('REJECTS a question that is too long or has no question mark', () => {
    const long = 'Brazil ' + 'pressing '.repeat(20) + 'this spell?';
    expect(validateProposal({ kind: 'shot_in_window', team: 'home', question: long, trueProb: 0.4, windowMs: 10_000 }, game(), NOW)).toBeNull();
    expect(validateProposal({ kind: 'shot_in_window', team: 'home', question: 'Brazil to get a shot away.', trueProb: 0.4, windowMs: 10_000 }, game(), NOW)).toBeNull();
  });

  it('CLAMPS trueProb, windowMs and relevance into safe bounds', () => {
    const p = validateProposal(
      { kind: 'goal_in_window', question: 'A goal by either side soon?', trueProb: 5, windowMs: 999_999, relevance: 50 },
      game(),
      NOW,
    )!;
    expect(p.trueProb).toBeLessThanOrEqual(0.95);
    expect(p.windowMs).toBeLessThanOrEqual(20_000);
    expect(p.windowMs).toBeGreaterThanOrEqual(6_000);
    expect(p.relevance).toBeLessThanOrEqual(1);
  });
});

describe('MarketDirector fail-open', () => {
  const stubCommentary = { formatForAi: () => '' } as unknown as CommentaryBuffer;

  it('is INACTIVE with no key and proposeNext returns undefined (rules run)', () => {
    const d = new MarketDirector({
      enabled: true,
      apiKey: undefined,
      model: 'm',
      timeoutMs: 1000,
      refreshMs: 1000,
      matchTokenBudget: 1000,
      commentary: stubCommentary,
      getContext: () => ({ game: game(), momentum: { home: 0, away: 0, intensity: 0, bar: null } }),
    });
    expect(d.active).toBe(false);
    expect(d.proposeNext(NOW, () => true)).toBeUndefined();
  });

  it('is INACTIVE when disabled even with a key', () => {
    const d = new MarketDirector({
      enabled: false,
      apiKey: 'sk-test',
      model: 'm',
      timeoutMs: 1000,
      refreshMs: 1000,
      matchTokenBudget: 1000,
      commentary: stubCommentary,
      getContext: () => ({ game: game(), momentum: { home: 0, away: 0, intensity: 0, bar: null } }),
    });
    expect(d.active).toBe(false);
  });
});
