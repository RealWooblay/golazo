import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Market, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';
import { bettingClosesAt } from './ai/marketTuning';

/**
 * ANTI-ARB (the TV-lag fix). Our ESPN feed lags the live broadcast by ~50s, so a viewer who
 * sees a goal on TV could bet on it before our feed reports it. The defense: a resolver event
 * may only settle a market if its TRUE (wallclock) time is at/after betting closed. An event
 * that really happened DURING the betting window is tainted — we IGNORE it (no void, no bet
 * touched) and the market keeps waiting. These tests pin that, using exact ESPN wallclocks.
 */
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

/** A goal carrying an EXACT ESPN wallclock (ms → ISO), so the taint check is deterministic. */
const goalAt = (team: Team, wallclockMs: number): FeedEvent => ({
  gameId: 'g1',
  ts: 0,
  type: 'goal',
  team,
  text: `goal ${team}`,
  meta: { clock: "30'", wallclock: new Date(wallclockMs).toISOString(), source: 'espn.keyEvent' },
});

/** A commentary event (shot/corner/attack) — NO wallclock, like the real ESPN feed. */
const commentary = (type: FeedEvent['type'], team: Team): FeedEvent => ({
  gameId: 'g1',
  ts: 0,
  type,
  team,
  text: `${type} ${team}`,
  meta: { clock: "30'" },
});

/** Tick until a goal_in_window market is open, then advance past its bet window so it's locked. */
async function openAndLockGoalWindow(orch: Orchestrator): Promise<Market> {
  for (let i = 0; i < 60; i++) {
    await orch.simTick();
    const m = orch.simMarkets().find((x) => x.kind === 'goal_in_window');
    if (m && (m.status === 'open' || m.status === 'locked')) break;
    await vi.advanceTimersByTimeAsync(15_000);
  }
  await vi.advanceTimersByTimeAsync(15_000); // past the bet window → locked
  await orch.simTick();
  return orch.simMarkets().find((x) => x.kind === 'goal_in_window')!;
}

/** Build momentum until a shot_or_corner_in_window market opens, then lock it. */
async function openAndLockShotOrCorner(orch: Orchestrator, feed: StubFeed): Promise<Market> {
  for (let i = 0; i < 80; i++) {
    feed.push([commentary('attack', 'home')]);
    await orch.simTick();
    const m = orch.simMarkets().find((x) => x.kind === 'shot_or_corner_in_window');
    if (m) {
      await vi.advanceTimersByTimeAsync(30_000); // past the bet window → locked
      await orch.simTick();
      return orch.simMarkets().find((x) => x.kind === 'shot_or_corner_in_window')!;
    }
    await vi.advanceTimersByTimeAsync(8_000);
  }
  throw new Error('no shot_or_corner market opened');
}

describe('anti-arb: a resolver that happened DURING betting is ignored', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT settle a goal-window market YES off a goal whose wallclock is during betting', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    const m = await openAndLockGoalWindow(orch);
    expect(m.status).toBe('locked');

    // A goal that REALLY happened 6s before betting closed — a TV viewer could have bet on it.
    const betClose = bettingClosesAt(m.lockAt, m.windowMs);
    feed.push([goalAt('home', betClose - 6_000)]);
    await orch.simTick();
    // Run PAST the deadline too: the (teamless) late-goal rescue must ALSO refuse to settle YES
    // on a during-betting goal — it's taint-gated just like the immediate path.
    await vi.advanceTimersByTimeAsync(400_000);
    await orch.simTick();

    const after = orch.simMarkets().find((x) => x.id === m.id)!;
    // The tainted goal is ignored on BOTH paths: the market settles NO, never YES.
    expect(after.settlement?.outcome).not.toBe('YES');
    await orch.stop();
  });

  it('DOES settle YES off a goal whose wallclock is after betting closed (clean resolver)', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    const m = await openAndLockGoalWindow(orch);

    // A goal that happened 8s AFTER betting closed — nobody could have bet on it.
    const betClose = bettingClosesAt(m.lockAt, m.windowMs);
    feed.push([goalAt('home', betClose + 8_000)]);
    await orch.simTick();

    const after = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(after.settlement?.outcome).toBe('YES');
    await orch.stop();
  });

  // A goal with NO exact wallclock FAILS OPEN (is counted). The match clock is whole-minute
  // granular while the betting window is ~10s, so any match-clock taint over-blocks legitimate
  // in-window goals far more often than it catches the rare arb — so we count it. This pins the
  // accepted residual: the precise taint only protects events that carry a wallclock.
  it('COUNTS a no-wallclock goal (fail-open — we cannot prove it happened during betting)', async () => {
    const feed = new StubFeed();
    feed.setClock("30'");
    const orch = new Orchestrator(simConfig(), feed);
    const m = await openAndLockGoalWindow(orch);
    expect(m.status).toBe('locked');

    feed.push([commentary('goal', 'home')]); // no wallclock at all
    await orch.simTick();
    const after = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(after.settlement?.outcome).toBe('YES');
    await orch.stop();
  });

  // The verification's second finding: a MISS must never rescue a pure goal-question market to
  // YES (recordResolverClock must be goals-only). A team that only missed has not scored.
  it('does NOT rescue a goal-question market to YES off a MISS', async () => {
    const feed = new StubFeed();
    feed.setClock("30'");
    const orch = new Orchestrator(simConfig(), feed);

    // Build a siege so a team-bound score_in_window market opens (needs high momentum).
    let m: Market | undefined;
    for (let i = 0; i < 80; i++) {
      feed.push([commentary('dangerous_attack', 'home')]);
      await orch.simTick();
      m = orch.simMarkets().find((x) => x.kind === 'score_in_window');
      if (m) break;
      await vi.advanceTimersByTimeAsync(6_000);
    }
    expect(m, 'a score_in_window market should open under siege').toBeTruthy();

    await vi.advanceTimersByTimeAsync(30_000); // lock it
    // The team only MISSES (no goal), well clear of the open minute, then we run past deadline.
    feed.push([{ ...commentary('miss', 'home'), meta: { clock: "34'" } }]);
    await orch.simTick();
    await vi.advanceTimersByTimeAsync(400_000);
    await orch.simTick();

    const after = orch.simMarkets().find((x) => x.id === m!.id)!;
    expect(after.settlement?.outcome).not.toBe('YES'); // a miss is not a goal
    await orch.stop();
  });

  // The verification's other blocking finding: "a shot OR corner this spell?" could never
  // settle YES on a corner (a bare corner never reached the resolver). It must now.
  it('settles shot_or_corner_in_window YES on a post-close CORNER', async () => {
    const feed = new StubFeed();
    const orch = new Orchestrator(simConfig(), feed);
    const m = await openAndLockShotOrCorner(orch, feed);
    expect(m.status).toBe('locked');

    feed.push([commentary('corner', (m.team as Team) ?? 'home')]);
    await orch.simTick();
    const after = orch.simMarkets().find((x) => x.id === m.id)!;
    expect(after.settlement?.outcome).toBe('YES');
    await orch.stop();
  });
});
