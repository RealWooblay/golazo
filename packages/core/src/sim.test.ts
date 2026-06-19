import { describe, expect, it } from 'vitest';
import { SimMatch, type Rng } from './sim';
import type { FeedEvent } from './types';

/**
 * A seeded LCG so the simulator is fully deterministic in tests. Real runs use
 * Math.random; here we want repeatable goal counts and reset timing.
 */
function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG, mapped to [0, 1).
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Match timing constants mirrored from sim.ts for the test harness. */
const MS_PER_GAME_MIN = 900;
const MATCH_MS = 90 * MS_PER_GAME_MIN; // 81_000ms == 90'
const CYCLE_MS = MATCH_MS + 6000; // match + reset beat

/**
 * Pump a SimMatch like a host would: step wall-clock time, drain `due()`, and
 * APPLY goals to the scoreline exactly as the app/orchestrator do. Returns the
 * full event log and a per-cycle tally.
 */
function runFor(sim: SimMatch, totalMs: number, stepMs = 200) {
  const events: FeedEvent[] = [];
  for (let now = 0; now <= totalMs; now += stepMs) {
    for (const ev of sim.due(now)) {
      events.push(ev);
      if (ev.type === 'goal' && ev.team) sim.applyGoal(ev.team);
    }
  }
  return events;
}

const ATTACK_TYPES: FeedEvent['type'][] = [
  'attack',
  'dangerous_attack',
  'corner',
  'free_kick',
  'penalty',
];

describe('SimMatch — public API shape', () => {
  it('starts 0-0, live, at 0\' with a kickoff queued', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(1) });
    expect(sim.state.scoreHome).toBe(0);
    expect(sim.state.scoreAway).toBe(0);
    expect(sim.state.status).toBe('live');
    expect(sim.state.clock).toBe("0'");
    const first = sim.due(0);
    expect(first[0]?.type).toBe('kickoff');
  });

  it('applyGoal + setClock still mutate state (passthrough API intact)', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(2) });
    sim.applyGoal('home');
    sim.applyGoal('away');
    sim.applyGoal('home');
    expect(sim.state.scoreHome).toBe(2);
    expect(sim.state.scoreAway).toBe(1);
    sim.setClock("45'");
    expect(sim.state.clock).toBe("45'");
  });
});

describe('SimMatch — markets stay FREQUENT', () => {
  it('opens many attack/market moments across a single match', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(7) });
    const events = runFor(sim, MATCH_MS); // one full 90'
    const attacks = events.filter((e) => ATTACK_TYPES.includes(e.type));
    // Betting needs a steady drumbeat of moments — a fresh market every few
    // seconds across the 90'.
    expect(attacks.length).toBeGreaterThanOrEqual(5);
    // Every attack still carries a market-seed prob for the watcher's odds.
    for (const a of attacks) {
      expect(typeof a.meta?.prob).toBe('number');
      expect(typeof a.meta?.sequenceId).toBe('string');
    }
  });
});

describe('SimMatch — goals are RARE (realistic scoreline)', () => {
  it('lands a realistic 0-5 total across many seeded full matches', () => {
    const totals: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const sim = new SimMatch({ startAt: 0, rng: lcg(seed * 131 + 17) });
      runFor(sim, MATCH_MS);
      const total = sim.state.scoreHome + sim.state.scoreAway;
      totals.push(total);
      // No single match should balloon into a basketball score.
      expect(total).toBeLessThanOrEqual(6);
    }
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    // Calibrated to a realistic football mean (~1.3 goals/match): assert we're
    // in a sane band and NOT resolving a high fraction of attacks as goals.
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(3.5);
  });

  it('scores far fewer goals than it opens markets', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(99) });
    const events = runFor(sim, MATCH_MS);
    const attacks = events.filter((e) => ATTACK_TYPES.includes(e.type)).length;
    const goals = events.filter((e) => e.type === 'goal').length;
    expect(goals).toBeLessThan(attacks); // markets >> goals
    expect(goals).toBeLessThanOrEqual(6);
  });
});

describe('SimMatch — ends at 90 and AUTO-RESETS', () => {
  it('flips to final at 90\' and emits exactly one final event', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(5) });
    // Pump right up to full time (but before the reset beat completes).
    const events = runFor(sim, MATCH_MS + 1000);
    expect(sim.state.clock).toBe("90'");
    expect(sim.state.status).toBe('final');
    const finals = events.filter((e) => e.type === 'final');
    expect(finals.length).toBe(1);
    // The final whistle stops new scoring: no goal/miss after the final event.
    const finalTs = finals[0]!.ts;
    const scoringAfter = events.filter(
      (e) => (e.type === 'goal' || e.type === 'miss') && e.ts > finalTs,
    );
    expect(scoringAfter.length).toBe(0);
  });

  it('resets clock AND score together into a fresh 0-0 live match', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(5) });
    // Force a goal-friendly first match so we can prove the score actually clears.
    runFor(sim, MATCH_MS + 1000);
    // Simulate the host having tracked some goals this match.
    sim.applyGoal('home');
    expect(sim.state.scoreHome).toBeGreaterThan(0);

    // Step just past the reset beat into the next cycle.
    const events = sim.due(CYCLE_MS + 50);
    expect(sim.state.clock).toBe("0'");
    expect(sim.state.scoreHome).toBe(0);
    expect(sim.state.scoreAway).toBe(0);
    expect(sim.state.status).toBe('live');
    // A fresh kickoff is emitted on the reset.
    expect(events.some((e) => e.type === 'kickoff')).toBe(true);
  });

  it('keeps cycling indefinitely without the score ballooning', () => {
    const sim = new SimMatch({ startAt: 0, rng: lcg(3) });
    // Run five full match cycles back to back.
    const events = runFor(sim, CYCLE_MS * 5);
    const kickoffs = events.filter((e) => e.type === 'kickoff').length;
    const finals = events.filter((e) => e.type === 'final').length;
    // One kickoff per match, one final whistle per completed match.
    expect(kickoffs).toBeGreaterThanOrEqual(5);
    expect(finals).toBeGreaterThanOrEqual(4);
    // Score is per-match (we reset the host tally on each kickoff would be the
    // app's job); here we assert the FINAL-cycle scoreline is itself realistic,
    // proving each match resets rather than accumulating.
    expect(sim.state.scoreHome + sim.state.scoreAway).toBeLessThanOrEqual(6);
  });
});
