import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';

/**
 * OVER/UNDER COUNT MARKET test — proves the generic per-market event COUNTER:
 *   • a count market ('over_corners') can be opened by the director/test hook,
 *   • each qualifying event since open bumps its running counter,
 *   • it settles YES the moment the count EXCEEDS the line (over),
 *   • and if the line is never crossed it stays open until the deadline NO (under).
 *
 * NO is still written ONLY by the deadline sweep — the counter only ever produces YES.
 */

/** A scripted FeedSource whose poll queue can be appended to mid-test. */
class StubFeed implements FeedSource {
  readonly kind = 'replay' as const;
  private clock = "30'";
  scoreHome = 0;
  scoreAway = 0;
  private readonly polls: FeedEvent[][] = [];
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
  /** Queue one batch of events to be returned by the NEXT poll. */
  push(batch: FeedEvent[]): void {
    this.polls.push(batch);
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

const corner = (team: Team): FeedEvent => ({
  gameId: 'g1',
  ts: 0,
  type: 'corner',
  team,
  text: `corner ${team}`,
  meta: { clock: "30'" },
});

async function openAndLockCountMarket(orch: Orchestrator): Promise<void> {
  await orch.simOpenMarket({
    gameId: 'g1',
    question: 'Over 1 corners in 5 min?',
    kind: 'over_corners',
    slot: 'count',
    windowMs: 8_000,
    trueProb: 0.45,
  });
  await vi.advanceTimersByTimeAsync(15_000);
  await orch.simTick();
}

describe('over/under COUNT market — the per-market event counter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles YES when the running corner count CROSSES the line (line=1 → 2 corners)', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);

    await openAndLockCountMarket(orch);
    const opened = orch.simMarkets().find((m) => m.kind === 'over_corners');
    expect(opened, 'an over_corners market should open via the sim hook').toBeTruthy();
    expect(opened!.status).toBe('locked');

    // First corner → count = 1 (== the line of 1, NOT over yet → no settle).
    feed.push([corner('home')]);
    await orch.simTick();
    let m = orch.simMarkets().find((mk) => mk.kind === 'over_corners')!;
    expect(m.settlement?.outcome, 'one corner is not yet OVER the line of 1').toBeUndefined();

    // Second corner → count = 2 (> line of 1) → YES.
    feed.push([corner('away')]);
    await orch.simTick();
    m = orch.simMarkets().find((mk) => mk.kind === 'over_corners')!;
    expect(m.settlement?.outcome).toBe('YES');

    await orch.stop();
  });

  it('settles NO at the deadline when the line is never crossed (UNDER)', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);

    await openAndLockCountMarket(orch);
    expect(orch.simMarkets().some((m) => m.kind === 'over_corners')).toBe(true);

    // Only ONE corner — never exceeds the line of 1.
    feed.push([corner('home')]);
    await orch.simTick();
    let m = orch.simMarkets().find((mk) => mk.kind === 'over_corners')!;
    expect(m.settlement?.outcome, 'still pending — under the line, deadline not reached').toBeUndefined();

    // Run past the deadline; the ONE-NO-WRITER sweep settles it NO (never the counter).
    await vi.advanceTimersByTimeAsync(400_000);
    await orch.simTick();
    m = orch.simMarkets().find((mk) => mk.kind === 'over_corners')!;
    expect(m.settlement?.outcome).toBe('NO');

    await orch.stop();
  });
});
