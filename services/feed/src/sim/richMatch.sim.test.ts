import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EspnReplayFeed } from '../feed/replay';
import { Orchestrator } from '../orchestrator';
import { loadFixture, fixtureFetch, simConfig, summarize, printReport, type SimReport } from './harness';

/**
 * THE COMPREHENSIVE END-TO-END MARKET SIM — the reliability gate.
 *
 * Replays a REALISTIC full ~90'+ match (Albion 3, Rovers 2 — `rich-match.json`)
 * through the real watcher + orchestrator. Unlike the thin one-goal Paraguay sim,
 * this fixture deliberately exercises EVERY market path:
 *   • goals of every type for BOTH teams: open play, from a corner, from a free
 *     kick, and a penalty — so set-piece YES attribution (parseGoalSource) is hit;
 *   • shots, misses, corners, free kicks (attacking + defensive), attacks,
 *     dangerous attacks, a red card behind a VAR review, a VAR penalty review;
 *   • momentum SWINGS (home siege → swing to away) and genuinely quiet spells so
 *     the bar must decay back toward neutral;
 *   • ESPN-style ~1-min feed lag + a couple of out-of-order stamps;
 *   • half-time and 90'+ stoppage.
 *
 * The owner's hard requirement is encoded as assertions: ZERO inaccuracy, NO
 * spurious voids, reliable momentum, good volume — and the FULL market catalog
 * actually reachable.
 */
describe('comprehensive full-game market simulation (rich-match)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run one full deterministic replay and return its report. */
  async function runMatch(): Promise<SimReport> {
    const fixture = loadFixture('rich-match');
    // Real-time spacing (60s per match-minute) so market windows behave exactly as
    // in production — resolutions land AFTER the betting window, not inside it.
    const feed = new EspnReplayFeed({
      league: 'fifa.world',
      eventId: '999001',
      fetchImpl: fixtureFetch(fixture),
      msPerGameMin: 60_000,
    });
    const started = await feed.start();
    expect(started).toBe(true);

    const orchestrator = new Orchestrator(simConfig(), feed);

    const STEP_MS = 5_000;
    const MATCH_MS = 100 * 60_000;
    for (let elapsed = 0; elapsed < MATCH_MS; elapsed += STEP_MS) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      await orchestrator.simTick();
    }
    // Final drain: let every lingering lock → deadline sweep fire.
    await vi.advanceTimersByTimeAsync(400_000);
    await orchestrator.simTick();

    const report = summarize(orchestrator);
    await orchestrator.stop();
    return report;
  }

  it('produces the full market catalog, resolves it accurately, with no spurious voids and a lively bar', async () => {
    const report = await runMatch();
    printReport('rich-match (Albion 3, Rovers 2)', report);

    // ── VOLUME ────────────────────────────────────────────────────────────────
    // 1. A busy, comprehensive match must print a lot of markets.
    expect(report.opened).toBeGreaterThanOrEqual(25);

    // 2. Momentum time-boxed markets are the volume engine.
    const momentumMarkets =
      (report.byKind['shot_in_window'] ?? 0) +
      (report.byKind['shot_or_corner_in_window'] ?? 0) +
      (report.byKind['score_in_window'] ?? 0);
    expect(momentumMarkets).toBeGreaterThanOrEqual(8);

    // ── NO HANG, NO SPURIOUS VOID ──────────────────────────────────────────────
    // 3. Nothing hangs: by full time no market is still open/locked.
    expect(report.hung).toBe(0);

    // 4. Every market reached a terminal state (resolved or void).
    const terminal = report.markets.filter(
      (m) => m.status === 'resolved' || m.status === 'void',
    ).length;
    expect(terminal).toBe(report.markets.length);

    // 5. NO SPURIOUS VOIDS. Only which-side-next CONTEST kinds may legitimately void — a
    //    refund when neither team did the event in the window (the contest never happened).
    //    EVERY OTHER kind voiding is the old "event didn't arrive → void" bug and must be
    //    zero. (Cause tags can rotate out of the capped audit buffer, so we assert on the
    //    KIND — the true invariant — not the audited cause.)
    const whichSide = ['next_shot', 'next_corner', 'next_goal'];
    const spuriousVoids = report.voids.filter(
      (v) => !whichSide.includes(v.kind) && v.cause !== 'match_switch',
    );
    expect(spuriousVoids).toEqual([]);

    // 6. Nothing hangs PENDING, and EVERY void is a which-side contest refund — no other
    //    kind ever voids (the spurious-void invariant, restated against the global tally).
    expect(report.byOutcome['PENDING'] ?? 0).toBe(0);
    const whichSideVoids = whichSide.reduce(
      (n, k) => n + (report.outcomeByKind[k]?.VOID ?? 0),
      0,
    );
    expect(report.byOutcome['VOID'] ?? 0).toBe(whichSideVoids);

    // ── ACCURACY: every in-window goal → its market YES, never NO/VOID ──────────
    // 7. A CORNER that actually produced a goal must settle goal_from_corner YES
    //    (parseGoalSource on ESPN's "...from a corner" text), and corners that
    //    fizzled settle NO. Both must appear — no NO-before-late-goal on the YES one.
    expect(report.outcomeByKind['goal_from_corner']?.YES ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['goal_from_corner']?.NO ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['goal_from_corner']?.VOID ?? 0).toBe(0);

    // 8. A FREE KICK that scored directly must settle goal_from_free_kick YES.
    expect(report.outcomeByKind['goal_from_free_kick']?.YES ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['goal_from_free_kick']?.NO ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['goal_from_free_kick']?.VOID ?? 0).toBe(0);

    // 9. A PENALTY awarded + converted must settle penalty_scored YES.
    expect(report.outcomeByKind['penalty_scored']?.YES ?? 0).toBeGreaterThanOrEqual(1);

    // 10. VAR markets: a review that produced a RED card settles red_card_given YES;
    //     the penalty reviews produce BOTH a YES (awarded) and a NO (denied).
    expect(report.outcomeByKind['red_card_given']?.YES ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['penalty_awarded']?.YES ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.outcomeByKind['penalty_awarded']?.NO ?? 0).toBeGreaterThanOrEqual(1);

    // 11. The TIMED momentum kinds resolve cleanly (no degenerate board). shot_in_window
    //     carries the volume and shows BOTH YES and NO. score_in_window is higher-
    //     conviction — it opens only at genuine siege intensity (>= MOMENTUM_GOAL_THRESHOLD,
    //     and with the per-tick decay only while pressure is still real), so in this
    //     goal-dense fixture those sieges score and it can be all-YES. Require it to open
    //     and resolve, and never VOID — not a fixture-luck NO.
    const shotKind = report.outcomeByKind['shot_in_window'];
    expect(shotKind?.YES ?? 0).toBeGreaterThan(0);
    expect(shotKind?.NO ?? 0).toBeGreaterThan(0);
    const scoreKind = report.outcomeByKind['score_in_window'];
    expect((scoreKind?.YES ?? 0) + (scoreKind?.NO ?? 0)).toBeGreaterThan(0);
    expect(scoreKind?.VOID ?? 0).toBe(0);

    // 12. Both teams' scoring moments resolve YES (attribution works for HOME + AWAY).
    const homeYes = report.markets.filter((m) => m.team === 'home' && m.outcome === 'YES');
    const awayYes = report.markets.filter((m) => m.team === 'away' && m.outcome === 'YES');
    expect(homeYes.length).toBeGreaterThanOrEqual(1);
    expect(awayYes.length).toBeGreaterThanOrEqual(1);

    // 13. Global YES + NO both present.
    expect(report.byOutcome['YES'] ?? 0).toBeGreaterThan(0);
    expect(report.byOutcome['NO'] ?? 0).toBeGreaterThan(0);

    // ── THE "in N minutes" TITLE IS CONCRETE ───────────────────────────────────
    // 14. Every score_in_window question names the actual window ("in the next 3
    //     minutes?"), never the vague "few minutes".
    const scoreQs = report.markets
      .filter((m) => m.kind === 'score_in_window')
      .map((m) => m.question);
    expect(scoreQs.length).toBeGreaterThan(0);
    expect(scoreQs.every((q) => /in the next \d+ minutes?\?/.test(q))).toBe(true);
    expect(scoreQs.some((q) => /few minutes/.test(q))).toBe(false);

    // ── MOMENTUM BAR: fires every event, flips sides, RISES + DECAYS ────────────
    // 15. The bar emits on essentially every event.
    expect(report.momentumEvents).toBeGreaterThanOrEqual(report.eventCount);

    // 16. It flips state several times and reaches BOTH sides (not stuck one team).
    expect(report.momentumFlips).toBeGreaterThanOrEqual(4);
    expect(report.momentumSides).toBe(2);

    // 17. The CONTINUOUS values track the run of play: each side's pressure RISES to
    //     a real peak when it presses…
    expect(report.momentumPeakHome).toBeGreaterThanOrEqual(4);
    expect(report.momentumPeakAway).toBeGreaterThanOrEqual(4);
    // …and DECAYS substantially from that peak in the quiet spells (the leading
    //     side's pressure bleeds back down — proving the value isn't stuck high).
    const peak = Math.max(report.momentumPeakHome, report.momentumPeakAway);
    expect(report.momentumQuietFloor).toBeLessThanOrEqual(peak * 0.6);
    // …and the bar genuinely RESTS NEUTRAL in lulls (not pinned to one team forever).
    expect(report.momentumNeutral).toBeGreaterThanOrEqual(3);

    // 18. No team-less markets leaked ("They — GOAL?").
    expect(report.markets.some((m) => /\bThey\b/.test(m.question))).toBe(false);
  });

  it('is byte-for-byte deterministic across two identical runs (no LLM in the sim)', async () => {
    const a = await runMatch();
    const b = await runMatch();
    expect(b.byOutcome).toEqual(a.byOutcome);
    expect(b.byKind).toEqual(a.byKind);
    expect(b.outcomeByKind).toEqual(a.outcomeByKind);
    expect(b.opened).toBe(a.opened);
    expect(b.resolved).toBe(a.resolved);
    expect(b.voided).toBe(a.voided);
    // The full market list (question/kind/status/outcome) is identical run-to-run.
    expect(b.markets).toEqual(a.markets);
  });
});
