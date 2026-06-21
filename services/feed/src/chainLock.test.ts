/**
 * CHAIN-LOCK GRACE — the operator must NOT flip the on-chain market to Locked the
 * instant the off-chain engine locks (at `windowMs`). A real-money `place_bet` only
 * lands after the client-side hold (BET_DELAY_MS) plus a devnet `confirmed`
 * round-trip, so an immediate chain lock makes that in-flight bet fail with
 * `MarketNotOpen` (0x1770). These tests pin the fix: the engine/UI lock at `windowMs`
 * (anti-snipe unchanged) but the chain lock is DEFERRED by CHAIN_LOCK_GRACE_MS — and
 * if the market settles first, the deferred lock is flushed BEFORE the on-chain
 * resolve so the operator never resolves a market that's still Open to bets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import { Orchestrator } from './orchestrator';
import { simConfig } from './sim/harness';
import type { FeedChainOperator } from './chain';

/** A market lifecycle call the fake operator recorded, with the fake-clock time. */
interface ChainOp {
  op: 'lock' | 'settle:YES' | 'settle:NO' | 'settle:VOID' | 'init';
  t: number;
}

const fakePubkey = { toBase58: () => 'Op1111111111111111111111111111111111111111' };

/**
 * A stand-in {@link FeedChainOperator}: `active` with an operator pubkey so the
 * orchestrator's chain path runs, and every lifecycle call recorded with the
 * current (fake) wall-clock so the test can assert WHEN the chain lock fired.
 */
function fakeChain(ops: ChainOp[]): FeedChainOperator {
  return {
    active: true,
    operatorPubkey: fakePubkey,
    initMarket: async () => {
      ops.push({ op: 'init', t: Date.now() });
      return { marketPda: fakePubkey, vaultPda: fakePubkey, signature: 'sig' };
    },
    lockMarket: async () => {
      ops.push({ op: 'lock', t: Date.now() });
      return null;
    },
    settleMarket: async (_seed: unknown, outcome: 'YES' | 'NO' | 'VOID') => {
      ops.push({ op: `settle:${outcome}` as ChainOp['op'], t: Date.now() });
      return null;
    },
  } as unknown as FeedChainOperator;
}

const GAME: GameState = {
  gameId: 'g1',
  sport: 'soccer',
  league: 'test',
  home: { id: 'h', name: 'Home', abbr: 'HOM' },
  away: { id: 'a', name: 'Away', abbr: 'AWY' },
  scoreHome: 0,
  scoreAway: 0,
  clock: "30'",
  status: 'live',
};

/** Minimal feed: yields each queued batch on successive polls, then nothing. */
function queueFeed(batches: FeedEvent[][]) {
  let i = 0;
  return {
    kind: 'sim' as const,
    state: () => GAME,
    poll: () => batches[i++] ?? [],
    applyGoal: () => {},
    setClock: () => {},
    close: async () => {},
  };
}

/** A single build-up event (weight 3 ≥ momentum open threshold) → opens ONE window market. */
function dangerousAttack(team: Team): FeedEvent {
  return {
    gameId: 'g1',
    ts: 0,
    type: 'dangerous_attack',
    team,
    text: 'surging forward',
    meta: { clock: "30'" },
  };
}

function goal(team: Team): FeedEvent {
  return { gameId: 'g1', ts: 0, type: 'goal', team, text: 'GOAL!', meta: { clock: "30'" } };
}

describe('on-chain lock grace', () => {
  beforeEach(() => {
    vi.useFakeTimers(); // clock starts at real `now` — the momentum opener cooldown
    // compares Date.now() to a 0 default, so a 0 epoch would suppress the first market.
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules the chain lock CHAIN_LOCK_GRACE_MS after the engine lock', async () => {
    const ops: ChainOp[] = [];
    const cfg = simConfig({ botCount: 0, chainLockGraceMs: 10_000 });
    const feed = queueFeed([[dangerousAttack('home')]]);
    const orch = new Orchestrator(cfg, feed, fakeChain(ops));

    // Open the market off the build-up event.
    await orch.simTick();
    const market = orch.simMarkets()[0];
    expect(market).toBeDefined();
    expect(market!.status).toBe('open');
    const { lockAt, windowMs } = market!; // lockAt = openedAt + windowMs = the engine lock time
    expect(ops.map((o) => o.op)).toEqual(['init']); // created on-chain, not locked

    // At the engine lock time the ENGINE/UI lock fires — but the chain twin stays Open.
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(orch.simMarkets()[0]!.status).toBe('locked');
    expect(ops.some((o) => o.op === 'lock')).toBe(false);

    // The chain lock lands only after the grace elapses — exactly lockAt + grace.
    await vi.advanceTimersByTimeAsync(cfg.chainLockGraceMs);
    const lock = ops.find((o) => o.op === 'lock');
    expect(lock).toBeDefined();
    expect(lock!.t).toBe(lockAt + cfg.chainLockGraceMs);
    // The whole point: the chain lock is scheduled strictly LATER than the engine lock.
    expect(lock!.t).toBeGreaterThan(lockAt);
    expect(lock!.t - lockAt).toBe(cfg.chainLockGraceMs);

    await orch.stop();
  });

  it('flushes the deferred chain lock BEFORE settling so resolve never races an open market', async () => {
    const ops: ChainOp[] = [];
    const cfg = simConfig({ botCount: 0, chainLockGraceMs: 10_000 });
    // Open on the build-up; a goal arrives on the next poll, after the engine lock.
    const feed = queueFeed([[dangerousAttack('home')], [goal('home')]]);
    const orch = new Orchestrator(cfg, feed, fakeChain(ops));

    await orch.simTick();
    const { lockAt, windowMs } = orch.simMarkets()[0]!;

    // Engine locks; chain lock is now deferred (pending) and not yet fired.
    await vi.advanceTimersByTimeAsync(windowMs);
    expect(ops.some((o) => o.op === 'lock')).toBe(false);

    // The goal settles the (locked) market YES BEFORE the grace timer would fire.
    await orch.simTick();

    const lifecycle = ops.filter((o) => o.op !== 'init').map((o) => o.op);
    // The deferred lock is flushed first, THEN the resolve — never the reverse.
    expect(lifecycle).toEqual(['lock', 'settle:YES']);
    const lock = ops.find((o) => o.op === 'lock')!;
    // Flushed at settle time (lockAt), NOT at the deferred lockAt + grace.
    expect(lock.t).toBe(lockAt);

    // The cancelled grace timer must not fire a second lock later.
    await vi.advanceTimersByTimeAsync(cfg.chainLockGraceMs * 2);
    expect(ops.filter((o) => o.op === 'lock')).toHaveLength(1);

    await orch.stop();
  });
});
