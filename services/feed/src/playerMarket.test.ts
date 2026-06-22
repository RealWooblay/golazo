import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';

/** A minimal FeedSource that emits a scripted sequence of event batches, one per poll. */
class StubFeed implements FeedSource {
  readonly kind = 'replay' as const;
  private clock = "30'";
  scoreHome = 0;
  scoreAway = 0;
  constructor(private readonly polls: FeedEvent[][]) {}
  state(): GameState {
    return {
      gameId: 'g1',
      sport: 'soccer',
      league: 'fifa.world',
      home: { id: 'h', name: 'Home', abbr: 'HOM' },
      away: { id: 'a', name: 'Away', abbr: 'AWY' },
      scoreHome: this.scoreHome,
      scoreAway: this.scoreAway,
      clock: this.clock,
      status: 'live',
    };
  }
  poll(): FeedEvent[] {
    return this.polls.shift() ?? [];
  }
  applyGoal(team: Team): void {
    if (team === 'home') this.scoreHome++;
    else this.scoreAway++;
  }
  setClock(c: string): void {
    this.clock = c;
  }
  async close(): Promise<void> {}
}

const ev = (type: FeedEvent['type'], team: Team, extra: Partial<FeedEvent> = {}): FeedEvent => ({
  gameId: 'g1',
  ts: 0,
  type,
  team,
  text: `${type} ${team}`,
  ...extra,
});

/** A goal keyEvent carrying ESPN's structured scorer (participants[0].athlete). */
const goal = (team: Team, id: string, name: string, seq: string): FeedEvent =>
  ev('goal', team, {
    text: `Goal! ${name} scores.`,
    meta: { player: { id, name }, clock: "30'", sequenceId: seq, source: 'espn.keyEvent' },
  });

const playerEvent = (
  type: 'shot' | 'miss',
  team: Team,
  id: string,
  name: string,
  seq: string,
): FeedEvent =>
  ev(type, team, {
    text: `${name} ${type === 'shot' ? 'has a shot saved' : 'misses from range'}.`,
    meta: { player: { id, name }, clock: "30'", sequenceId: seq, source: 'espn.keyEvent' },
  });

describe('player markets (will <player> score?)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not open a player market from a goal alone', async () => {
    const feed = new StubFeed([
      [goal('home', '297328', 'Galarza', 'g1')],
      [ev('attack', 'home', { text: 'home on the ball' })],
    ]);
    const orch = new Orchestrator(simConfig(), feed);

    await orch.simTick();
    await orch.simTick();
    expect(orch.simMarkets().find((m) => m.kind === 'player_to_score')).toBeUndefined();
    await orch.stop();
  });

  it('opens off sustained player shot threat and resolves YES only when THAT player scores', async () => {
    const feed = new StubFeed([
      [playerEvent('shot', 'home', '297328', 'Galarza', 's1')],
      [playerEvent('miss', 'home', '297328', 'Galarza', 's2')],
      [ev('attack', 'home', { text: 'home on the ball' })], // build-up → opens the player market
      [],
      [goal('home', '297328', 'Galarza', 'g2')], // Galarza scores again → YES
    ]);
    const orch = new Orchestrator(simConfig(), feed);

    await orch.simTick();
    await orch.simTick();
    await orch.simTick();
    const opened = orch.simMarkets().find((m) => m.kind === 'player_to_score');
    expect(opened, 'a player_to_score market should open for the in-form scorer').toBeTruthy();
    expect(opened!.question).toContain('Galarza');

    await vi.advanceTimersByTimeAsync(20_000); // lock the market
    await orch.simTick(); // empty poll
    await orch.simTick(); // Galarza scores again
    await vi.advanceTimersByTimeAsync(5_000);
    await orch.simTick();

    const settled = orch.simMarkets().find((m) => m.kind === 'player_to_score');
    expect(settled!.settlement?.outcome).toBe('YES');

    await orch.stop();
  });

  it('does NOT resolve YES when a DIFFERENT player scores', async () => {
    const feed = new StubFeed([
      [playerEvent('shot', 'home', '297328', 'Galarza', 's1')],
      [playerEvent('miss', 'home', '297328', 'Galarza', 's2')],
      [ev('attack', 'home')],
      [],
      [goal('home', '999', 'Someone Else', 'g2')], // a different scorer
    ]);
    const orch = new Orchestrator(simConfig(), feed);

    await orch.simTick();
    await orch.simTick();
    await orch.simTick();
    expect(orch.simMarkets().find((m) => m.kind === 'player_to_score')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(20_000);
    await orch.simTick();
    await orch.simTick();

    const pm = orch.simMarkets().find((m) => m.kind === 'player_to_score');
    expect(pm!.settlement?.outcome).not.toBe('YES'); // the other player's goal is not Galarza's
    await orch.stop();
  });
});
