import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Market } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';

class StubFeed implements FeedSource {
  readonly kind = 'replay' as const;
  private clock = "93'";
  scoreHome = 1;
  scoreAway = 1;
  private readonly polls: FeedEvent[][] = [];
  private statusVal: GameState['status'] = 'live';

  state(): GameState {
    return {
      gameId: 'g1',
      sport: 'soccer',
      league: 'fifa.world',
      home: { id: 'h', name: 'Netherlands', abbr: 'NED' },
      away: { id: 'a', name: 'Morocco', abbr: 'MAR' },
      scoreHome: this.scoreHome,
      scoreAway: this.scoreAway,
      clock: this.clock,
      status: this.statusVal,
    };
  }

  poll(): FeedEvent[] {
    return this.polls.shift() ?? [];
  }
  push(batch: FeedEvent[]): void {
    this.polls.push(batch);
  }
  applyGoal(team: 'home' | 'away'): void {
    if (team === 'home') this.scoreHome++;
    else this.scoreAway++;
  }
  setClock(c: string): void {
    this.clock = c;
  }
  setStatus(s: GameState['status']): void {
    this.statusVal = s;
  }
  async close(): Promise<void> {}
}

const goal = (team: 'home' | 'away'): FeedEvent => ({
  gameId: 'g1',
  ts: Date.now(),
  type: 'goal',
  team,
  text: 'Goal!',
  meta: { clock: "100'", source: 'espn.keyEvent' as const },
});

describe('goes_to_penalties market', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens when level in early ET', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    await orch.simTick();
    const m = orch.simMarkets().find((x) => x.kind === 'goes_to_penalties');
    expect(m, 'PK market should open on level ET').toBeTruthy();
    await orch.stop();
  });

  it('stays open through an ET goal — NO only when the match ends without PK', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    await orch.simTick();
    let m = orch.simMarkets().find((x) => x.kind === 'goes_to_penalties')!;
    expect(m).toBeTruthy();
    await vi.advanceTimersByTimeAsync(12_000);
    await orch.simTick();
    m = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(m.status).toBe('locked');

    feed.push([goal('home')]);
    feed.scoreHome = 2;
    await orch.simTick();
    m = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(m.status).toBe('locked');

    feed.setStatus('final');
    await orch.simTick();
    m = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(m.status).toBe('resolved');
    expect(m.settlement?.outcome).toBe('NO');
    await orch.stop();
  });

  it('settles YES when penalty shootout begins', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    await orch.simTick();
    let m = orch.simMarkets().find((x) => x.kind === 'goes_to_penalties') as Market;
    expect(m).toBeTruthy();
    await vi.advanceTimersByTimeAsync(12_000);
    await orch.simTick();

    feed.setClock('Penalty Shootout');
    await orch.simTick();
    m = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(m.status).toBe('resolved');
    expect(m.settlement?.outcome).toBe('YES');
    await orch.stop();
  });
});
