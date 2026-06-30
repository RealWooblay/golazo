/**
 * E2E MONEY SIMULATION — the test that proves "what would actually happen to a bettor's money".
 *
 * Where fullGame.sim.test.ts proves the FEED side (markets open / resolve / never hang), this
 * proves the MONEY side end-to-end: a full match of bettors placing real bets through the REAL
 * engine + settlement, then each bettor's result derived through the SAME `userBetFromSettlement`
 * the deployed client uses. It debits at bet, credits at settle, tracks every balance, and
 * asserts the invariants that, if broken, lose real USX:
 *
 *   • CONSERVATION — across the whole match, the bettors collectively lose EXACTLY the rake
 *     (sum of every P&L === −total rake). No money is minted or vanishes.
 *   • NO DOUBLE-PAY — a bettor is paid at most once per market.
 *   • VOID / ONE-SIDED === REFUND — net 0, never a −stake loss and never a sub-1.0x "win".
 *   • NOT-IN-POOL === REFUND — a bet that never entered the pool (anti-snipe delay/reject) is
 *     refunded, not booked as a loss.
 *   • WIN === side matched outcome (never payout>stake), and winners split exactly the net pool.
 *   • NO NEGATIVE BALANCES — a bettor can never spend money they don't have.
 *
 * Deterministic (seeded LCG, no Date/Math.random), so it's a hard regression guard: change
 * anything on the money path and a broken invariant fails here BEFORE it ships.
 *
 * It's also a readable "match report" — run with the logs on to literally see the game play out.
 */
import { describe, it, expect } from 'vitest';
import { MarketEngine } from './engine';
import { userBetFromSettlement } from './parimutuel';
import type { Outcome, Side } from './types';

const RAKE = 0.06;
const START_BALANCE = 1000;
const EPS = 1e-6;

/** Deterministic PRNG (LCG) — no Math.random, so every run is identical. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Bettor {
  id: string;
  balance: number;
  staked: number;
  returned: number;
  bets: number;
  wins: number;
  losses: number;
  refunds: number;
}

interface BetIntent {
  bettor: Bettor;
  side: Side;
  stake: number;
  /** false = the bet never reaches the pool (anti-snipe delay / reject) — must refund. */
  entersPool: boolean;
}

interface MarketSpec {
  kind: string;
  question: string;
  team?: 'home' | 'away';
  /** How the round is decided. 'one_sided' forces every bet onto YES (book voids by design). */
  outcome: Outcome;
  intents: (rng: () => number, bettors: Bettor[]) => BetIntent[];
}

interface RoundResult {
  spec: MarketSpec;
  settledOutcome: Outcome;
  gross: number;
  rake: number;
  paidToWinners: number;
  lines: Array<{ id: string; side: Side; stake: number; result: string; delta: number }>;
}

function runMatch(seed: number): { rounds: RoundResult[]; bettors: Bettor[]; totalRake: number } {
  const rng = lcg(seed);
  const engine = new MarketEngine({ rake: RAKE, baseSeed: 0 });
  const bettors: Bettor[] = Array.from({ length: 6 }, (_, i) => ({
    id: `u${i + 1}`,
    balance: START_BALANCE,
    staked: 0,
    returned: 0,
    bets: 0,
    wins: 0,
    losses: 0,
    refunds: 0,
  }));

  // A full match: scripted edge cases (the bug-prone ones) + seeded "crowd" rounds.
  const STAKES = [10, 25, 50, 100];
  const crowd =
    (outcome: Outcome) =>
    (r: () => number, bs: Bettor[]): BetIntent[] =>
      bs
        .filter(() => r() > 0.25) // ~75% of the crowd takes each market
        .map((b) => ({
          bettor: b,
          side: (r() > 0.5 ? 'YES' : 'NO') as Side,
          stake: STAKES[Math.floor(r() * STAKES.length)],
          entersPool: true,
        }));

  const script: MarketSpec[] = [
    // 1) Two-sided YES win — heavy NO money makes a thin YES side pay a BIG (>2x) multiple.
    {
      kind: 'next_goal', question: 'Who scores next — home or away?', team: 'home', outcome: 'YES',
      intents: (_r, bs) => [
        { bettor: bs[0], side: 'YES', stake: 25, entersPool: true }, // lone winner → big multiple
        { bettor: bs[1], side: 'NO', stake: 100, entersPool: true },
        { bettor: bs[2], side: 'NO', stake: 100, entersPool: true },
        { bettor: bs[3], side: 'NO', stake: 50, entersPool: true },
      ],
    },
    // 2) Two-sided NO win.
    {
      kind: 'shot_in_window', question: 'A shot on goal in the next 2 min?', outcome: 'NO',
      intents: (_r, bs) => [
        { bettor: bs[0], side: 'YES', stake: 50, entersPool: true },
        { bettor: bs[1], side: 'NO', stake: 25, entersPool: true },
        { bettor: bs[4], side: 'NO', stake: 25, entersPool: true },
      ],
    },
    // 3) ONE-SIDED book (everyone YES) — settle must VOID + refund all (the solo-bettor case).
    {
      kind: 'next_corner', question: 'Who wins the next corner?', team: 'away', outcome: 'YES',
      intents: (_r, bs) => [
        { bettor: bs[0], side: 'YES', stake: 50, entersPool: true },
        { bettor: bs[2], side: 'YES', stake: 25, entersPool: true },
        { bettor: bs[5], side: 'YES', stake: 100, entersPool: true },
      ],
    },
    // 4) Explicit VOID (match abandoned mid-market) — refund all, no rake.
    {
      kind: 'goal_in_window', question: 'Another goal before half-time?', outcome: 'VOID',
      intents: (_r, bs) => [
        { bettor: bs[1], side: 'YES', stake: 50, entersPool: true },
        { bettor: bs[3], side: 'NO', stake: 50, entersPool: true },
      ],
    },
    // 5) NOT-IN-POOL — u5 taps late, the anti-snipe delay drops the bet AFTER lock. Must REFUND
    //    u5 (net 0), not book a loss, even though the market resolves against their side.
    {
      kind: 'next_booking', question: 'Who gets booked next?', team: 'home', outcome: 'NO',
      intents: (_r, bs) => [
        { bettor: bs[0], side: 'NO', stake: 50, entersPool: true },
        { bettor: bs[1], side: 'YES', stake: 50, entersPool: true },
        { bettor: bs[4], side: 'YES', stake: 100, entersPool: false }, // dropped → refund
      ],
    },
  ];
  // Seeded crowd rounds so the match feels full + the invariants face varied distributions.
  for (let i = 0; i < 10; i++) {
    const outcome: Outcome = rng() > 0.5 ? 'YES' : 'NO';
    script.push({
      kind: i % 2 ? 'shots_race' : 'next_goal',
      question: `Crowd round ${i + 1}`,
      outcome,
      intents: crowd(outcome),
    });
  }

  const rounds: RoundResult[] = [];
  let totalRake = 0;
  let marketSeq = 0;

  for (const spec of script) {
    const m = engine.openMarket({
      gameId: 'e2e',
      kind: spec.kind,
      slot: 'window',
      team: spec.team,
      question: spec.question,
      windowMs: 9000,
      trueProb: 0.4,
      resolveWindowMs: 16000,
    });
    marketSeq++;
    const intents = spec.intents(rng, bettors);

    // Place bets: debit the wallet now (real flow), and only the ones that ENTER the pool reach
    // the engine. The user can't bet what they don't have — skip (and assert) any overspend.
    for (const it of intents) {
      expect(it.stake).toBeLessThanOrEqual(it.bettor.balance + EPS); // NO NEGATIVE BALANCES
      it.bettor.balance -= it.stake;
      it.bettor.staked += it.stake;
      it.bettor.bets += 1;
      if (it.entersPool) engine.placeBet(m.id, it.bettor.id, it.side, it.stake);
    }

    const settlement = engine.resolve(m.id, spec.outcome);

    // CONSERVATION per market: gross (pool money) = rake + everything paid to winners.
    const gross = settlement.payouts
      .filter((p) => settlement.outcome !== 'VOID')
      .reduce((s, p) => s + p.stake, 0);
    totalRake += settlement.rakeTaken;

    // NO DOUBLE-PAY: each bettor appears at most once in payouts.
    const ids = settlement.payouts.map((p) => p.userId);
    expect(new Set(ids).size).toBe(ids.length);

    const lines: RoundResult['lines'] = [];
    for (const it of intents) {
      const r = userBetFromSettlement(settlement, it.bettor.id, it.stake, it.side);
      // Credit the wallet with whatever is owed (full payout / refund / nothing).
      it.bettor.balance += r.payout;
      it.bettor.returned += r.payout;

      let result: string;
      if (settlement.outcome === 'VOID' || !it.entersPool) {
        // VOID, one-sided, or never-in-pool → exact stake refund, net 0.
        expect(r.delta).toBeCloseTo(0, 6);
        expect(r.payout).toBeCloseTo(it.stake, 6);
        expect(r.won).toBe(false);
        it.bettor.refunds += 1;
        result = it.entersPool ? 'refund(void)' : 'refund(not-in-pool)';
      } else if (it.side === settlement.outcome) {
        // WIN === side matched the outcome. Winner is paid a share of the net pool — usually
        // >stake, but CAN be <stake on a heavy favorite (the losing pool is smaller than the
        // rake, so part of the winners' own principal is raked). That's correct parimutuel and
        // is disclosed pre-bet by the <1x quote — so we assert payout>0 + the net identity, not
        // payout>stake. (won is still true; delta can be negative.)
        expect(r.won).toBe(true);
        expect(r.payout).toBeGreaterThan(0);
        expect(r.delta).toBeCloseTo(r.payout - it.stake, 6);
        it.bettor.wins += 1;
        result = `WIN ${(r.payout / it.stake).toFixed(2)}x`;
      } else {
        // LOSS === side missed. Net is exactly −stake (never a phantom void/refund).
        expect(r.won).toBe(false);
        expect(r.payout).toBe(0);
        expect(r.delta).toBeCloseTo(-it.stake, 6);
        it.bettor.losses += 1;
        result = 'loss';
      }
      lines.push({ id: it.bettor.id, side: it.side, stake: it.stake, result, delta: r.delta });
    }

    // CONSERVATION: winners split exactly (gross − rake) on a settled two-sided book.
    if (settlement.outcome !== 'VOID') {
      const paid = settlement.payouts.reduce((s, p) => s + p.payout, 0);
      expect(paid).toBeCloseTo(gross - settlement.rakeTaken, 4);
      rounds.push({
        spec, settledOutcome: settlement.outcome, gross, rake: settlement.rakeTaken,
        paidToWinners: paid, lines,
      });
    } else {
      rounds.push({
        spec, settledOutcome: 'VOID', gross: 0, rake: 0, paidToWinners: 0, lines,
      });
    }
  }

  return { rounds, bettors, totalRake };
}

function printMatch(label: string, rounds: RoundResult[], bettors: Bettor[], totalRake: number): void {
  const lines: string[] = [`\n=== E2E MONEY SIM: ${label} ===`];
  rounds.forEach((r, i) => {
    lines.push(
      `\n#${i + 1} [${r.settledOutcome}] ${r.spec.kind} — ${r.spec.question}` +
        (r.settledOutcome !== 'VOID'
          ? `  (pool $${r.gross.toFixed(0)}, rake $${r.rake.toFixed(2)}, paid $${r.paidToWinners.toFixed(2)})`
          : '  (refunded)'),
    );
    for (const l of r.lines) {
      lines.push(`    ${l.id} ${l.side} $${l.stake} → ${l.result}  (${l.delta >= 0 ? '+' : ''}${l.delta.toFixed(2)})`);
    }
  });
  lines.push('\n--- final ledger ---');
  for (const b of bettors) {
    const pnl = b.balance - START_BALANCE;
    lines.push(
      `  ${b.id}: $${b.balance.toFixed(2)}  (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})  ` +
        `${b.bets} bets · ${b.wins}W ${b.losses}L ${b.refunds}R`,
    );
  }
  const totalPnl = bettors.reduce((s, b) => s + (b.balance - START_BALANCE), 0);
  lines.push(`\n  house rake: $${totalRake.toFixed(2)}   bettor net P&L: $${totalPnl.toFixed(2)}   (sum must be ~0)`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('E2E money simulation (full match, real engine + settlement)', () => {
  it('settles a full match with every money invariant intact', () => {
    const { rounds, bettors, totalRake } = runMatch(20260630);
    printMatch('seed 20260630', rounds, bettors, totalRake);

    // The match actually exercised the edge cases we care about.
    expect(rounds.length).toBeGreaterThanOrEqual(15);
    expect(rounds.some((r) => r.settledOutcome === 'VOID')).toBe(true); // void + one-sided present
    expect(rounds.some((r) => r.lines.some((l) => l.result.startsWith('WIN') && parseFloat(l.result.slice(4)) > 2))).toBe(true); // a >2x win
    expect(rounds.some((r) => r.lines.some((l) => l.result === 'refund(not-in-pool)'))).toBe(true);

    // GLOBAL CONSERVATION: bettors collectively lose EXACTLY the rake — no money minted/lost.
    const totalPnl = bettors.reduce((s, b) => s + (b.balance - START_BALANCE), 0);
    expect(totalPnl).toBeCloseTo(-totalRake, 4);

    // Per-bettor balance integrity: end balance === start + (returned − staked), never negative.
    for (const b of bettors) {
      expect(b.balance).toBeGreaterThanOrEqual(-EPS);
      expect(b.balance).toBeCloseTo(START_BALANCE - b.staked + b.returned, 6);
    }
    // Rake is real (some two-sided books settled) but never exceeds 6% of all staked money.
    const totalStaked = bettors.reduce((s, b) => s + b.staked, 0);
    expect(totalRake).toBeGreaterThan(0);
    expect(totalRake).toBeLessThanOrEqual(totalStaked * RAKE + EPS);
  });

  it('is deterministic across runs (regression guard)', () => {
    const a = runMatch(20260630);
    const b = runMatch(20260630);
    expect(b.totalRake).toBeCloseTo(a.totalRake, 9);
    expect(b.bettors.map((x) => x.balance)).toEqual(a.bettors.map((x) => x.balance));
  });

  it('holds the invariants across many different matches (fuzz)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { bettors, totalRake } = runMatch(seed * 7919);
      const totalPnl = bettors.reduce((s, b) => s + (b.balance - START_BALANCE), 0);
      expect(totalPnl).toBeCloseTo(-totalRake, 3); // conservation holds for every match
      for (const b of bettors) expect(b.balance).toBeGreaterThanOrEqual(-EPS);
    }
  });
});
