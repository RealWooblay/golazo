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
    minConfidence: 0.3,
    feedMode: 'replay',
    espnLeague: 'fifa.world',
    espnCommentaryLang: 'dual',
    replayEventId: '760443',
    espnPollMs: 2_500,
    rake: 0.06,
    feeRecipient: 'sim',
    baseSeed: 0,
    // A little bot liquidity so NO/YES settlements aren't downgraded to VOID for
    // want of a winning pool — makes the sim's outcome mix realistic.
    botCount: 8,
    resolveTimeoutMs: 30_000,
    betDelayMs: 2_000,
    betSafetyBufferMs: 1_000,
    chainEnabled: false,
    operatorKeypair: undefined,
    solanaRpcUrl: 'http://localhost:8899',
    golazoProgramId: 'sim',
    chainSeedLamports: 0,
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
  byOutcome: Record<string, number>;
  byKind: Record<string, number>;
  markets: Array<{ question: string; kind: string; status: string; outcome?: string }>;
}

/** Summarize what the orchestrator produced over a full simulated match. */
export function summarize(orchestrator: Orchestrator): SimReport {
  const markets = orchestrator.simMarkets();
  const m = orchestrator.metrics;
  const byOutcome: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let hung = 0;
  for (const mk of markets) {
    byKind[mk.kind] = (byKind[mk.kind] ?? 0) + 1;
    if (mk.status === 'open' || mk.status === 'locked') hung++;
    const oc = mk.settlement?.outcome ?? (mk.status === 'void' ? 'VOID' : 'PENDING');
    byOutcome[oc] = (byOutcome[oc] ?? 0) + 1;
  }
  return {
    opened: m.marketsOpened,
    resolved: m.marketsResolved,
    voided: m.marketsVoided,
    skipped: m.marketsSkipped,
    hung,
    byOutcome,
    byKind,
    markets: markets.map((mk: Market) => ({
      question: mk.question,
      kind: mk.kind,
      status: mk.status,
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
      `byKind=${JSON.stringify(r.byKind)}\n` +
      `byOutcome=${JSON.stringify(r.byOutcome)}\n` +
      r.markets
        .map((mk) => `  [${mk.status}${mk.outcome ? `/${mk.outcome}` : ''}] ${mk.kind} — ${mk.question}`)
        .join('\n'),
  );
}
