import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';
import type { MarketProposal } from './ai/director';

class StubFeed implements FeedSource {
  readonly kind = 'replay' as const;

  state(): GameState {
    return {
      gameId: 'g1',
      sport: 'soccer',
      league: 'fifa.world',
      home: { id: 'ned', name: 'Netherlands', abbr: 'NED' },
      away: { id: 'mar', name: 'Morocco', abbr: 'MAR' },
      scoreHome: 1,
      scoreAway: 0,
      clock: "62'",
      status: 'live',
    };
  }

  poll(): FeedEvent[] {
    return [];
  }

  applyGoal(_team: Team): void {}
  setClock(_clock: string): void {}
  async close(): Promise<void> {}
}

function recentAttack(): FeedEvent {
  return {
    gameId: 'g1',
    ts: Date.now(),
    type: 'attack',
    team: 'away',
    text: 'Morocco push forward after the restart.',
    meta: { clock: "62'" },
  };
}

function proposal(
  kind: 'next_goal' | 'next_shot',
  relevance: number,
  bornAt = Date.now(),
): MarketProposal {
  return {
    kind,
    slot: 'versus',
    team: 'away',
    question:
      kind === 'next_goal'
        ? 'Who scores next: Morocco or Netherlands?'
        : 'Next shot: Morocco or Netherlands?',
    trueProb: 0.5,
    windowMs: 10_000,
    relevance,
    bornAt,
  };
}

describe('AI director orchestrator gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips queued goal-followup proposals after a goal and opens the safer restart market', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(
      simConfig({ aiDirectorEnabled: true, anthropicApiKey: 'test-key' }),
      feed,
    );
    const unsafe = orch as unknown as {
      director: { pool: MarketProposal[] };
      recent: FeedEvent[];
      lastGoalAt: Map<Team, number>;
      maybeOpenDirectorMarket: (game: GameState) => Promise<boolean>;
    };

    unsafe.recent.push(recentAttack());
    // After the 20s silence, but still inside the 120s goal-followup cooldown:
    // next_goal must remain blocked, while a restart-context next_shot can open.
    unsafe.lastGoalAt.set('home', Date.now() - 30_000);
    unsafe.director.pool = [proposal('next_goal', 0.99), proposal('next_shot', 0.7)];

    const opened = await unsafe.maybeOpenDirectorMarket(feed.state());
    expect(opened).toBe(true);
    expect(orch.simMarkets()).toHaveLength(1);
    expect(orch.simMarkets()[0]!.kind).toBe('next_shot');
    expect(orch.simMarkets()[0]!.question).toBe('Next shot: Morocco or Netherlands?');

    await orch.stop();
  });
});
