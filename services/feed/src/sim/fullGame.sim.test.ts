import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EspnReplayFeed } from '../feed/replay';
import { Orchestrator } from '../orchestrator';
import { loadFixture, fixtureFetch, simConfig, summarize, printReport, type SimReport } from './harness';

/**
 * THE END-TO-END MARKET SIM. Replays a full real match (Paraguay vs Türkiye —
 * incl. the Paraguay open-play goal and the VAR red-card incident) through the
 * real watcher + orchestrator and asserts the reliability invariants of the
 * deterministic-resolution overhaul:
 *   1. NO spurious voids (voided ≈ 0).
 *   2. No NO/VOID on a market whose team actually scored in-window.
 *   3. Every market reaches a terminal state by full time (nothing hangs).
 *   4. The momentum bar fires ~every event AND flips sides across the match.
 *   5. Volume is up (more openers, ≥8 momentum time-boxed markets).
 *   6. Both YES and NO outcomes occur (no degenerate all-NO board).
 *   7. The pipeline is fully deterministic (no LLM in the sim).
 */
describe('full-game market simulation (Paraguay vs Türkiye replay)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run one full deterministic replay and return its report. */
  async function runMatch(): Promise<SimReport> {
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
    // Final drain: let every lingering lock → deadline sweep fire.
    await vi.advanceTimersByTimeAsync(300_000);
    await orchestrator.simTick();

    const report = summarize(orchestrator);
    await orchestrator.stop();
    return report;
  }

  it('resolves deterministically with no spurious voids and a lively momentum bar', async () => {
    const report = await runMatch();
    printReport('Paraguay vs Türkiye', report);

    // 1. SPAM, not silence — a full game must produce a busy stream of markets.
    expect(report.opened).toBeGreaterThanOrEqual(25);

    // 2. Momentum DRIVES volume — the time-boxed markets are the main opener path.
    const momentumMarkets =
      (report.byKind['shot_in_window'] ?? 0) + (report.byKind['score_in_window'] ?? 0);
    expect(momentumMarkets).toBeGreaterThanOrEqual(8);

    // 3. Nothing hangs: by full time, no market is still open/locked.
    expect(report.hung).toBe(0);

    // 4. Every market reached a terminal state (resolved or void) — none stuck.
    const terminal = report.markets.filter(
      (m) => m.status === 'resolved' || m.status === 'void',
    ).length;
    expect(terminal).toBe(report.markets.length);

    // 5. THE CORE FIX — no spurious voids. VOID is reserved for genuine feed outage,
    //    NOT "the event didn't arrive." A late goal on the 2-min feed must be NO/YES.
    expect(report.voided).toBeLessThanOrEqual(1);

    // 6. Resolution is overwhelmingly real (resolved, not void).
    const resolvedShare = report.resolved / (report.resolved + report.voided);
    expect(resolvedShare).toBeGreaterThanOrEqual(0.95);

    // 7. NO NO-before-late-YES regression. Paraguay (the AWAY side) actually SCORE
    //    (an open-play goal, final 0–1); their momentum/open-play markets live at
    //    goal time must settle YES, never NO/VOID. Assert: the scoring side has ≥1
    //    YES and NONE of its markets voided (a void there would be the old bug).
    const scorerMarkets = report.markets.filter((m) => m.team === 'away');
    const scorerYes = scorerMarkets.filter((m) => m.outcome === 'YES');
    expect(scorerYes.length).toBeGreaterThanOrEqual(1);
    expect(scorerMarkets.every((m) => m.status !== 'void')).toBe(true);

    // 8. Both YES and NO outcomes occur — no degenerate all-NO board.
    expect(report.byOutcome['YES'] ?? 0).toBeGreaterThan(0);
    expect(report.byOutcome['NO'] ?? 0).toBeGreaterThan(0);

    // 9. The momentum bar emits on essentially EVERY event AND moves: it changes
    //    state several times and reaches BOTH sides (not stuck leaning one team).
    expect(report.momentumEvents).toBeGreaterThanOrEqual(report.eventCount);
    expect(report.momentumFlips).toBeGreaterThanOrEqual(3);
    expect(report.momentumSides).toBe(2);

    // 10. No team-less markets leaked ("They — GOAL?").
    expect(report.markets.some((m) => /\bThey\b/.test(m.question))).toBe(false);
  });

  it('is byte-for-byte deterministic across two runs (no LLM in the sim)', async () => {
    const a = await runMatch();
    const b = await runMatch();
    // With the fuzzy/AI judge deleted, the pipeline is fully deterministic — the
    // outcome mix and kind mix must be identical across runs.
    expect(b.byOutcome).toEqual(a.byOutcome);
    expect(b.byKind).toEqual(a.byKind);
    expect(b.opened).toBe(a.opened);
    expect(b.voided).toBe(a.voided);
  });
});
