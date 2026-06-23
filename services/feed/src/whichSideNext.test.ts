import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Market, Team } from '@golazo/core';
import type { FeedSource } from './feed/index';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';
import { isWhichSideNextKind, decisiveEventTypes } from './ai/marketTuning';

/**
 * WHICH-SIDE-NEXT contest test — proves the ONLY family that writes NO on an EVENT:
 *   • the market's team threatens first  → YES,
 *   • the OTHER team threatens first     → NO   (a scoped, audited decisive-event NO),
 *   • neither team by the deadline       → VOID/refund (NEVER the deadline NO).
 *
 * This is the arb-/fairness-critical path: a which-side market must NEVER settle NO at the
 * deadline (that would be an un-refunded loss on a contest that never happened), and a
 * later same-team threat must NOT flip a held "the other team went first" NO (first wins).
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

const mk = (type: FeedEvent['type'], team?: Team): FeedEvent => ({
  gameId: 'g1',
  ts: 0,
  type,
  ...(team ? { team } : {}),
  text: `${type} ${team ?? ''}`,
  meta: { clock: "30'" },
});

/**
 * Pump build-up attacking events (which both build momentum past the pressure gate AND are
 * the event-driven trigger) until the first which-side contest opens, then advance past its
 * 10s betting window so it's LOCKED (a later decisive event settles immediately, not held).
 * The first contest always has team='home' (versusCounter starts at 0).
 */
async function openAndLockVersus(orch: Orchestrator, feed: StubFeed): Promise<Market> {
  for (let i = 0; i < 60; i++) {
    feed.push([mk('dangerous_attack', i % 2 === 0 ? 'home' : 'away')]);
    await orch.simTick();
    const m = orch.simMarkets().find((x) => x.kind === 'next_shot');
    if (m) {
      await vi.advanceTimersByTimeAsync(15_000); // past the betting window → locked
      await orch.simTick();
      return orch.simMarkets().find((x) => x.kind === 'next_shot')!;
    }
    await vi.advanceTimersByTimeAsync(20_000);
  }
  throw new Error('no which-side contest opened');
}

describe('which-side-next contest — the scoped decisive-event NO', () => {
  it('palette: only next_* kinds are which-side, and next_shot decides on any real threat', () => {
    expect(isWhichSideNextKind('next_shot')).toBe(true);
    expect(isWhichSideNextKind('next_corner')).toBe(true);
    expect(isWhichSideNextKind('shot_in_window')).toBe(false);
    expect(isWhichSideNextKind('over_corners')).toBe(false);
    // The broad "who threatens next?" set — a shot, a corner, OR a dangerous attack.
    const set = decisiveEventTypes('next_shot');
    for (const t of ['shot', 'miss', 'goal', 'corner', 'dangerous_attack'] as const) {
      expect(set.has(t)).toBe(true);
    }
    expect(set.has('free_kick')).toBe(false);
  });

  describe('resolution', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('settles NO when the OTHER team threatens first (the scoped event-NO)', async () => {
      const feed = new StubFeed();
      const orch = new Orchestrator(simConfig(), feed);
      const m = await openAndLockVersus(orch, feed);
      expect(m.team).toBe('home');
      expect(m.status).toBe('locked');

      // The AWAY team takes the next shot → the home-team contest settles NO.
      feed.push([mk('shot', 'away')]);
      await orch.simTick();
      const after = orch.simMarkets().find((x) => x.id === m.id)!;
      expect(after.settlement?.outcome).toBe('NO');
      await orch.stop();
    });

    it('settles YES when the MARKET team threatens first', async () => {
      const feed = new StubFeed();
      const orch = new Orchestrator(simConfig(), feed);
      const m = await openAndLockVersus(orch, feed);
      expect(m.team).toBe('home');

      feed.push([mk('shot', 'home')]);
      await orch.simTick();
      const after = orch.simMarkets().find((x) => x.id === m.id)!;
      expect(after.settlement?.outcome).toBe('YES');
      await orch.stop();
    });

    it('VOIDs/refunds at the deadline when NEITHER team threatens — never settles NO', async () => {
      const feed = new StubFeed();
      const orch = new Orchestrator(simConfig(), feed);
      const m = await openAndLockVersus(orch, feed);

      // No decisive event at all — run well past the deadline. The deadline sweep must
      // VOID (refund), NOT write NO: the contest never happened.
      await vi.advanceTimersByTimeAsync(600_000);
      await orch.simTick();
      const after = orch.simMarkets().find((x) => x.id === m.id)!;
      expect(after.status).toBe('void');
      expect(after.settlement?.outcome).toBe('VOID');
      await orch.stop();
    });
  });
});
