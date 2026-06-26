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

describe('MarketDirector.validateProposal — the palette + selection wall', () => {
  it('accepts a team-bound proposal, builds the question from the bank, derives the slot', () => {
    const p = validateProposal(
      { kind: 'next_shot', team: 'home', line: 0, trueProb: 0.5, windowMs: 10_000, relevance: 0.8 },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('next_shot');
    expect(p!.slot).toBe('versus');
    expect(p!.team).toBe('home');
    // Built from the curated bank with {team}/{opp} substituted (home = Brazil = YES side first).
    expect(p!.question).toBe('Who threatens next: Brazil or Argentina?');
    expect(p!.bornAt).toBe(NOW);
  });

  it('accepts a teamless either-team proposal and builds its question', () => {
    const p = validateProposal(
      { kind: 'goal_in_window', line: 1, trueProb: 0.3, windowMs: 9_000, relevance: 0.6 },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.team).toBeUndefined();
    expect(p!.question.endsWith('?')).toBe(true);
  });

  it('IGNORES any free-text question — the AI can never WRITE wording, only SELECT it', () => {
    const p = validateProposal(
      {
        kind: 'shot_in_window',
        team: 'away',
        line: 0,
        question: 'totally made up free text 123',
        trueProb: 0.4,
        windowMs: 10_000,
      },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    // The free text is discarded; the question comes from the bank and names the away side.
    expect(p!.question).toContain('Argentina');
    expect(p!.question).not.toContain('made up');
    expect(/\d/.test(p!.question)).toBe(false);
  });

  it('CLAMPS an out-of-range line index into the bank (never rejects for it)', () => {
    const p = validateProposal(
      { kind: 'card_in_window', line: 999, trueProb: 0.3, windowMs: 9_000, relevance: 0.5 },
      game(),
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.question.endsWith('?')).toBe(true);
  });

  it('REJECTS an off-palette kind (the AI can never invent a kind)', () => {
    expect(DIRECTOR_PALETTE.has('penalty_scored')).toBe(false);
    expect(
      validateProposal(
        { kind: 'penalty_scored', team: 'home', line: 0, trueProb: 0.8, windowMs: 10_000, relevance: 1 },
        game(),
        NOW,
      ),
    ).toBeNull();
    expect(validateProposal({ kind: 'made_up_kind', line: 0, trueProb: 0.5, windowMs: 10_000 }, game(), NOW)).toBeNull();
  });

  it('REJECTS a team-bound kind with no/invalid team, and a teamless kind that carries a team', () => {
    // shot_in_window needs a real team.
    expect(validateProposal({ kind: 'shot_in_window', line: 0, trueProb: 0.4, windowMs: 10_000 }, game(), NOW)).toBeNull();
    expect(
      validateProposal({ kind: 'shot_in_window', team: 'nobody', line: 0, trueProb: 0.4, windowMs: 10_000 }, game(), NOW),
    ).toBeNull();
    // over_corners must NOT carry a team.
    expect(
      validateProposal({ kind: 'over_corners', team: 'home', line: 0, trueProb: 0.5, windowMs: 10_000 }, game(), NOW),
    ).toBeNull();
  });

  it('CLAMPS trueProb, windowMs and relevance into safe bounds', () => {
    const p = validateProposal(
      { kind: 'goal_in_window', line: 0, trueProb: 5, windowMs: 999_999, relevance: 50 },
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
