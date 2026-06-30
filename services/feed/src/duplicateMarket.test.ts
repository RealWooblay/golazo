import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GameState, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';

class StubFeed implements FeedSource {
  readonly kind = 'replay' as const;
  state(): GameState {
    return {
      gameId: 'g1',
      sport: 'soccer',
      league: 'fifa.world',
      home: { id: 'ned', name: 'Netherlands', abbr: 'NED' },
      away: { id: 'mar', name: 'Morocco', abbr: 'MAR' },
      scoreHome: 0,
      scoreAway: 0,
      clock: "32'",
      status: 'live',
    };
  }
  poll() {
    return [];
  }
  applyGoal(_team: Team): void {}
  setClock(_clock: string): void {}
  async close(): Promise<void> {}
}

describe('duplicate market guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks a second score_in_window for the same team while the first is still live', async () => {
    const orch = new Orchestrator(simConfig(), new StubFeed());
    const trigger = {
      gameId: 'g1',
      question: 'Morocco to make this pressure pay?',
      kind: 'score_in_window',
      slot: 'window' as const,
      team: 'away' as const,
      windowMs: 10_000,
      trueProb: 0.4,
    };
    const first = await orch.simOpenMarket(trigger);
    expect(first).toBeTruthy();

    const second = await orch.simOpenMarket(trigger);
    expect(second).toBeUndefined();
    expect(orch.simMarkets().filter((m) => m.kind === 'score_in_window' && m.team === 'away')).toHaveLength(
      1,
    );
  });

  it('blocks a second next_shot even when the YES-side team differs (same contest)', async () => {
    const orch = new Orchestrator(simConfig(), new StubFeed());
    const first = await orch.simOpenMarket({
      gameId: 'g1',
      question: 'Next effort on goal: Netherlands or Morocco?',
      kind: 'next_shot',
      slot: 'versus',
      team: 'home',
      windowMs: 10_000,
      trueProb: 0.4,
    });
    expect(first).toBeTruthy();

    const second = await orch.simOpenMarket({
      gameId: 'g1',
      question: 'Next effort on goal: Morocco or Netherlands?',
      kind: 'next_shot',
      slot: 'versus',
      team: 'away',
      windowMs: 10_000,
      trueProb: 0.4,
    });
    expect(second).toBeUndefined();
    expect(orch.simMarkets().filter((m) => m.kind === 'next_shot')).toHaveLength(1);
  });
});
