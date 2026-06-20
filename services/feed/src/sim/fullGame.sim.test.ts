import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EspnReplayFeed } from '../feed/replay';
import { Orchestrator } from '../orchestrator';
import { loadFixture, fixtureFetch, simConfig, summarize, printReport } from './harness';

/**
 * THE END-TO-END MARKET SIM. Replays a full real match (Paraguay vs Türkiye —
 * 157 commentary lines, 64 key events, incl. the VAR red-card incident) through
 * the real watcher + orchestrator and asserts the product invariants:
 *   1. Markets actually OPEN over the course of a game (not "no markets").
 *   2. Nothing HANGS — every market is resolved/voided by full time.
 *   3. Both teams get markets (no team-less "They …" markets leak through).
 */
describe('full-game market simulation (Paraguay vs Türkiye replay)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens a healthy stream of markets and resolves them all by full time', async () => {
    const fixture = loadFixture('paraguay-turkiye');
    // Real-time spacing (60s per match-minute) so market windows behave exactly
    // as in production — resolutions land AFTER the betting window, not inside it.
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: '760443',
      fetchImpl: fixtureFetch(fixture),
      msPerGameMin: 60_000,
    });
    const started = await feed.start();
    expect(started).toBe(true);

    const orchestrator = new Orchestrator(simConfig(), feed);

    // Drive the whole match under fake timers: advance wall-clock, tick the
    // pipeline. ~98' of play + a generous drain so every lock→resolve fires.
    const STEP_MS = 5_000;
    const MATCH_MS = 100 * 60_000;
    for (let elapsed = 0; elapsed < MATCH_MS; elapsed += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      await orchestrator.simTick();
    }
    // Final drain: let every lingering lock → resolve/void timer fire.
    await vi.advanceTimersByTimeAsync(300_000);
    await orchestrator.simTick();

    const report = summarize(orchestrator);
    printReport('Paraguay vs Türkiye', report);

    // 1. SPAM, not silence — a full game must produce a busy stream of markets.
    expect(report.opened).toBeGreaterThanOrEqual(20);

    // 2. Momentum DRIVES markets — the agent's pressure read opens chances/goals.
    const momentumMarkets =
      (report.byKind['chance_from_play'] ?? 0) + (report.byKind['goal_from_open_play'] ?? 0);
    expect(momentumMarkets).toBeGreaterThanOrEqual(4);

    // 3. Nothing hangs: by full time, no market is still open/locked.
    expect(report.hung).toBe(0);

    // 4. Every market reached a terminal state (resolved or void) — none stuck.
    const terminal = report.markets.filter(
      (m) => m.status === 'resolved' || m.status === 'void',
    ).length;
    expect(terminal).toBe(report.markets.length);

    // 5. Markets mostly RESOLVE (not void) — voids are the fair-refund exception.
    expect(report.voided).toBeLessThan(report.resolved);

    // 6. No team-less markets leaked ("They — GOAL?").
    expect(report.markets.some((m) => /\bThey\b/.test(m.question))).toBe(false);
  });
});
