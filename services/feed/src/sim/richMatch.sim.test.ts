import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EspnReplayFeed } from '../feed/replay';
import { Orchestrator } from '../orchestrator';
import { loadFixture, fixtureFetch, simConfig, summarize, printReport, type SimReport } from './harness';

/**
 * THE COMPREHENSIVE END-TO-END MARKET SIM — the reliability gate.
 *
 * Replays a REALISTIC full ~90'+ match (Albion 3, Rovers 2 — `rich-match.json`)
 * through the real watcher + orchestrator. This fixture deliberately exercises
 * the launch fallback policy with a busy match:
 *   • goals for BOTH teams, shots, misses, corners, attacks, VAR/card/penalty text;
 *   • shots, misses, corners, free kicks (attacking + defensive), attacks,
 *     dangerous attacks, a red card behind a VAR review, a VAR penalty review;
 *   • momentum SWINGS (home siege → swing to away) and genuinely quiet spells so
 *     the bar must decay back toward neutral;
 *   • ESPN-style ~1-min feed lag + a couple of out-of-order stamps;
 *   • half-time and 90'+ stoppage.
 *
 * The owner's hard requirement is encoded as assertions: ZERO inaccuracy, NO
 * spurious voids, reliable momentum, diverse market families, and a fresh-board
 * floor when the AI director is unavailable in the sim.
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

  it('runs the launch fallback policy with clean resolution and diverse safe markets', async () => {
    const report = await runMatch();
    printReport('rich-match (Albion 3, Rovers 2)', report);

    // ── VOLUME ────────────────────────────────────────────────────────────────
    // 1. A busy, comprehensive match must print a lot of markets.
    expect(report.opened).toBeGreaterThanOrEqual(25);
    // ...but the board must not become an unreadable wall of cards.
    expect(report.opened).toBeLessThanOrEqual(120);

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
    const whichSide = ['next_shot', 'next_corner', 'next_goal', 'next_card'];
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

    // 7. With AI_DIRECTOR off in the sim, deterministic fallback must stay to the
    //    safe launch family: broad windows, counts, either-team events, and next-shot
    //    contests. Narrow/long versus markets stay director-only because they void more.
    expect(Object.keys(report.byKind).sort()).toEqual([
      'card_in_window',
      'goal_in_window',
      'next_shot',
      'over_corners',
      'over_shots',
      'shot_in_window',
      'shot_or_corner_in_window',
    ]);
    for (const kind of ['next_corner', 'next_goal', 'next_card']) {
      expect(report.byKind[kind] ?? 0).toBe(0);
    }

    // 8. The TIMED momentum kinds resolve cleanly and show BOTH YES and NO.
    const shotKind = report.outcomeByKind['shot_in_window'];
    expect(shotKind?.YES ?? 0).toBeGreaterThan(0);
    expect(shotKind?.NO ?? 0).toBeGreaterThan(0);
    const shotCornerKind = report.outcomeByKind['shot_or_corner_in_window'];
    expect(shotCornerKind?.YES ?? 0).toBeGreaterThan(0);
    expect(shotCornerKind?.NO ?? 0).toBeGreaterThan(0);
    expect(shotKind?.VOID ?? 0).toBe(0);
    expect(shotCornerKind?.VOID ?? 0).toBe(0);

    // 9. Both teams' scoring/chance moments resolve YES (attribution works for HOME + AWAY).
    const homeYes = report.markets.filter((m) => m.team === 'home' && m.outcome === 'YES');
    const awayYes = report.markets.filter((m) => m.team === 'away' && m.outcome === 'YES');
    expect(homeYes.length).toBeGreaterThanOrEqual(1);
    expect(awayYes.length).toBeGreaterThanOrEqual(1);

    // 10. Global YES + NO both present.
    expect(report.byOutcome['YES'] ?? 0).toBeGreaterThan(0);
    expect(report.byOutcome['NO'] ?? 0).toBeGreaterThan(0);

    // ── MOMENTUM BAR: fires every event, flips sides, RISES + DECAYS ────────────
    // 11. The bar emits on essentially every event.
    expect(report.momentumEvents).toBeGreaterThanOrEqual(report.eventCount);

    // 12. It flips state several times and reaches BOTH sides (not stuck one team).
    expect(report.momentumFlips).toBeGreaterThanOrEqual(4);
    expect(report.momentumSides).toBe(2);

    // 13. The CONTINUOUS values track the run of play: each side's pressure RISES to
    //     a real peak when it presses…
    expect(report.momentumPeakHome).toBeGreaterThanOrEqual(4);
    expect(report.momentumPeakAway).toBeGreaterThanOrEqual(4);
    // …and DECAYS substantially from that peak in the quiet spells (the leading
    //     side's pressure bleeds back down — proving the value isn't stuck high).
    const peak = Math.max(report.momentumPeakHome, report.momentumPeakAway);
    expect(report.momentumQuietFloor).toBeLessThanOrEqual(peak * 0.6);
    // …and the bar genuinely RESTS NEUTRAL in lulls (not pinned to one team forever).
    expect(report.momentumNeutral).toBeGreaterThanOrEqual(3);

    // 14. No team-less markets leaked ("They — GOAL?").
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
