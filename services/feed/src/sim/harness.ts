/**
 * Full-game SIMULATION harness — replays a real match's ESPN commentary through
 * the ACTUAL market pipeline (watcher → gating → engine → resolution) headlessly,
 * so we can measure: how many markets open, do they resolve correctly, and does
 * anything hang. No network (canned fixture), no WS server (we drive ticks by
 * hand), no chain, no bots — just the decision + resolution logic.
 *
 * This is the "pull a full game and see how it goes" test the product needs to
 * trust that markets actually get created and settled.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Market } from '@golazo/core';
import type { Config } from '../config';
import type { Orchestrator } from '../orchestrator';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface GameFixture {
  scoreboard: unknown;
  summary: unknown;
}

/** Load a canned ESPN scoreboard+summary fixture from `__fixtures__`. */
export function loadFixture(name: string): GameFixture {
  const raw = readFileSync(join(HERE, '__fixtures__', `${name}.json`), 'utf8');
  return JSON.parse(raw) as GameFixture;
}

/** A fetch that serves the fixture — `/summary` → summary, else scoreboard. */
export function fixtureFetch(fixture: GameFixture): typeof fetch {
  return (async (url: string) => {
    const body = String(url).includes('/summary') ? fixture.summary : fixture.scoreboard;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

/** A complete feed Config wired for a deterministic, offline replay simulation. */
export function simConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    anthropicApiKey: undefined,
    aiModel: 'sim',
    aiTimeoutMs: 1_000,
    aiResolveTimeoutMs: 1_000,
    aiDirectorEnabled: false,
    aiRefreshMs: 15_000,
    aiMatchTokenBudget: 120_000,
    minConfidence: 0.3,
    feedMode: 'replay',
    espnLeague: 'fifa.world',
    espnCommentaryLang: 'dual',
    replayEventId: '760443',
    forceEventId: undefined,
    pointsBotCount: 0,
    pointsBotMinStake: 8,
    pointsBotMaxStake: 60,
    espnPollMs: 2_500,
    rake: 0.06,
    pointsStorePath: undefined, // sims/tests are pure in-memory — never touch disk
    feeRecipient: 'sim',
    baseSeed: 0,
    // Bots are OFF in production (the live points/real multiple must move on real
    // user money only). The offline sim has no human bettors, so it keeps them ON as
    // bettor stand-ins: a little liquidity so NO/YES settlements aren't downgraded to
    // VOID for want of a winning pool, keeping the sim's outcome mix realistic.
    liquidityBotsEnabled: true,
    botCount: 8,
    resolveTimeoutMs: 30_000,
    betDelayMs: 2_000,
    pointsBetDelayMs: 2_000,
    betSafetyBufferMs: 1_000,
    chainEnabled: false,
    operatorKeypair: undefined,
    solanaRpcUrl: 'http://localhost:8899',
    golazoProgramId: 'sim',
    chainSeedLamports: 0,
    chainLockGraceMs: 10_000,
    ...overrides,
  };
}

export interface SimReport {
  opened: number;
  resolved: number;
  voided: number;
  skipped: number;
  /** Markets still open/locked when the match ended — these are BUGS (hung). */
  hung: number;
  /** Events the pipeline processed (the bar broadcasts once per event). */
  eventCount: number;
  /** Momentum bar values broadcast this run (should be ~one per event). */
  momentumEvents: number;
  /** Number of times the bar changed state — home/away/neutral (proves it MOVES). */
  momentumFlips: number;
  /** Distinct non-neutral sides the bar reached (both = it isn't stuck on one team). */
  momentumSides: number;
  /** Peak home pressure value reached (proves the bar RISES for a pressing team). */
  momentumPeakHome: number;
  /** Peak away pressure value reached. */
  momentumPeakAway: number;
  /** Lowest the LEADING side's pressure decayed to after first reaching a real peak
   *  (proves the bar bleeds back toward neutral in quiet spells — not stuck high). */
  momentumQuietFloor: number;
  /** Count of broadcasts where the bar rested NEUTRAL (null) — proves it returns to
   *  even in lulls rather than staying pinned to one team. */
  momentumNeutral: number;
  byOutcome: Record<string, number>;
  byKind: Record<string, number>;
  /** Per-kind YES/NO/VOID tallies — lets us assert a corner-goal YES, a FK-goal YES, etc. */
  outcomeByKind: Record<string, { YES: number; NO: number; VOID: number }>;
  /** Markets that VOIDed — with the audit cause, so we can prove the cause is a match-switch. */
  voids: Array<{ kind: string; question: string; cause: string }>;
  markets: Array<{
    question: string;
    kind: string;
    status: string;
    team?: string;
    outcome?: string;
  }>;
}

/** Summarize what the orchestrator produced over a full simulated match. */
export function summarize(orchestrator: Orchestrator): SimReport {
  const markets = orchestrator.simMarkets();
  const m = orchestrator.metrics;
  const byOutcome: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const outcomeByKind: Record<string, { YES: number; NO: number; VOID: number }> = {};
  let hung = 0;
  for (const mk of markets) {
    byKind[mk.kind] = (byKind[mk.kind] ?? 0) + 1;
    if (mk.status === 'open' || mk.status === 'locked') hung++;
    const oc = mk.settlement?.outcome ?? (mk.status === 'void' ? 'VOID' : 'PENDING');
    byOutcome[oc] = (byOutcome[oc] ?? 0) + 1;
    const slot = (outcomeByKind[mk.kind] ??= { YES: 0, NO: 0, VOID: 0 });
    if (oc === 'YES' || oc === 'NO' || oc === 'VOID') slot[oc] += 1;
  }

  // VOID provenance: pair each voided market with its audit `cause`, so the sim can
  // PROVE every void is a genuine match-switch (never "the event didn't arrive").
  const audit = orchestrator.simAudit();
  const voidCause = new Map<string, string>();
  for (const e of audit) {
    if (e.kind === 'market_void' && e.marketId) {
      voidCause.set(e.marketId, String(e.detail.cause ?? e.detail.reason ?? 'unknown'));
    }
  }
  const voids = markets
    .filter((mk) => mk.status === 'void')
    .map((mk) => ({
      kind: mk.kind,
      question: mk.question,
      cause: voidCause.get(mk.id) ?? 'unknown',
    }));

  // Momentum bar liveness: count broadcasts, how often the bar CHANGED state
  // (home/away/neutral — proves it moves), how many distinct sides it reached
  // (both = not stuck), the PEAK pressure each side reached (proves it RISES for a
  // pressing team), and the lowest it decayed to after a real peak (proves it bleeds
  // back toward neutral in quiet spells — i.e. the value tracks the run of play).
  const bars = orchestrator.simMomentum();
  let momentumFlips = 0;
  const sidesSeen = new Set<'home' | 'away'>();
  let prev: 'home' | 'away' | null | undefined;
  let momentumPeakHome = 0;
  let momentumPeakAway = 0;
  let momentumQuietFloor = Number.POSITIVE_INFINITY;
  let momentumNeutral = 0;
  let sawRealPeak = false;
  for (const b of bars) {
    if (b.bar !== null) sidesSeen.add(b.bar);
    else momentumNeutral++;
    if (prev !== undefined && b.bar !== prev) momentumFlips++;
    prev = b.bar;
    momentumPeakHome = Math.max(momentumPeakHome, b.home);
    momentumPeakAway = Math.max(momentumPeakAway, b.away);
    // Once the bar has climbed to a genuine peak, track how low the LEADING side's
    // pressure later dips — a quiet spell (decay, no weighted events) must bleed it
    // back down toward neutral rather than leaving it pinned at the peak.
    if (Math.max(b.home, b.away) >= 4) sawRealPeak = true;
    if (sawRealPeak) momentumQuietFloor = Math.min(momentumQuietFloor, Math.max(b.home, b.away));
  }
  if (!Number.isFinite(momentumQuietFloor)) momentumQuietFloor = 0;

  return {
    opened: m.marketsOpened,
    resolved: m.marketsResolved,
    voided: m.marketsVoided,
    skipped: m.marketsSkipped,
    hung,
    eventCount: m.eventsProcessed,
    momentumEvents: bars.length,
    momentumFlips,
    momentumSides: sidesSeen.size,
    momentumPeakHome,
    momentumPeakAway,
    momentumQuietFloor,
    momentumNeutral,
    byOutcome,
    byKind,
    outcomeByKind,
    voids,
    markets: markets.map((mk: Market) => ({
      question: mk.question,
      kind: mk.kind,
      status: mk.status,
      ...(mk.team ? { team: mk.team } : {}),
      ...(mk.settlement?.outcome ? { outcome: mk.settlement.outcome } : {}),
    })),
  };
}

/** Pretty-print a report (used by the sim test so CI logs show the result). */
export function printReport(label: string, r: SimReport): void {
  // eslint-disable-next-line no-console
  console.log(
    `\n=== SIM: ${label} ===\n` +
      `opened=${r.opened} resolved=${r.resolved} voided=${r.voided} ` +
      `skipped=${r.skipped} hung=${r.hung}\n` +
      `events=${r.eventCount} momentumEvents=${r.momentumEvents} ` +
      `momentumFlips=${r.momentumFlips} momentumSides=${r.momentumSides} ` +
      `peakHome=${r.momentumPeakHome} peakAway=${r.momentumPeakAway} ` +
      `quietFloor=${r.momentumQuietFloor} neutral=${r.momentumNeutral}\n` +
      `byKind=${JSON.stringify(r.byKind)}\n` +
      `byOutcome=${JSON.stringify(r.byOutcome)}\n` +
      `outcomeByKind=${JSON.stringify(r.outcomeByKind)}\n` +
      `voids=${JSON.stringify(r.voids)}\n` +
      r.markets
        .map((mk) => `  [${mk.status}${mk.outcome ? `/${mk.outcome}` : ''}] ${mk.kind} — ${mk.question}`)
        .join('\n'),
  );
}
