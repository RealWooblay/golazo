import { describe, expect, it } from 'vitest';
import { QuestionEnhancer, validateLine } from './enhancer';
import { CommentaryBuffer } from './commentaryBuffer';
import type { GameState } from '@golazo/core';

const GAME: GameState = {
  gameId: 'g1',
  home: { name: 'New Zealand', score: 0 },
  away: { name: 'Egypt', score: 0 },
  status: 'live',
  clock: "23'",
} as unknown as GameState;

function makeEnhancer(enabled: boolean) {
  return new QuestionEnhancer({
    apiKey: enabled ? 'sk-test' : undefined,
    enabled,
    model: 'claude-haiku-4-5',
    timeoutMs: 4000,
    refreshMs: 15000,
    matchTokenBudget: 120000,
    scoreWindowMins: 2,
    commentary: new CommentaryBuffer(),
    getContext: () => ({ game: GAME, momentum: { home: 0, away: 0, leader: undefined, intensity: 0, bar: null } }),
  });
}

describe('validateLine', () => {
  it('accepts a clean shot line that names the team + carries the keyword', () => {
    expect(validateLine('New Zealand pushing — a SHOT this spell?', 'New Zealand', 'shot_in_window', 2)).toBe(true);
  });
  it('accepts a score line with ONLY the legitimate window minute', () => {
    expect(validateLine('New Zealand to SCORE in the next 2 minutes?', 'New Zealand', 'score_in_window', 2)).toBe(true);
  });
  it('REJECTS a hallucinated scoreline (stray digits)', () => {
    expect(validateLine('New Zealand 2, Egypt 0 — SHOT next?', 'New Zealand', 'shot_in_window', 2)).toBe(false);
    // a score line may keep the window minute (2) but not a fabricated scoreline:
    expect(validateLine('New Zealand lead 1, can they SCORE in 2?', 'New Zealand', 'score_in_window', 2)).toBe(false);
  });
  it('REJECTS when the team is not named (no "they")', () => {
    expect(validateLine('Pushing forward — a SHOT this spell?', 'New Zealand', 'shot_in_window', 2)).toBe(false);
  });
  it('REJECTS when the kind keyword is missing', () => {
    expect(validateLine('New Zealand are pressing hard right now?', 'New Zealand', 'shot_in_window', 2)).toBe(false);
  });
  it('REJECTS out-of-bounds lengths', () => {
    expect(validateLine('SHOT?', 'New Zealand', 'shot_in_window', 2)).toBe(false);
    expect(validateLine('New Zealand ' + 'really '.repeat(20) + 'SHOT?', 'New Zealand', 'shot_in_window', 2)).toBe(false);
  });
});

describe('QuestionEnhancer fail-open', () => {
  it('is inactive and returns the template when disabled / unkeyed', () => {
    const e = makeEnhancer(false);
    expect(e.active).toBe(false);
    expect(e.pick('home', 'shot_in_window', 'TEMPLATE', Date.now())).toBe('TEMPLATE');
  });
  it('returns the template for kinds it does not enhance', () => {
    const e = makeEnhancer(true);
    expect(e.pick('home', 'player_to_score', 'TEMPLATE', Date.now())).toBe('TEMPLATE');
  });
  it('returns the template when the pool is empty (no refresh yet)', () => {
    const e = makeEnhancer(true);
    expect(e.pick('home', 'shot_in_window', 'TEMPLATE', Date.now())).toBe('TEMPLATE');
  });
});
