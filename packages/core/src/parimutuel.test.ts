import { describe, it, expect } from 'vitest';
import {
  grossPool,
  impliedOdds,
  impliedProb,
  indicativeQuote,
  settle,
  type Bet,
  type Pool,
} from './parimutuel';

const RAKE = 0.06;

describe('pool odds', () => {
  it('keeps empty markets finite and neutral', () => {
    const pool: Pool = { yes: 0, no: 0 };
    expect(grossPool(pool)).toBe(0);
    expect(impliedProb(pool)).toBe(0.5);
    expect(impliedOdds(pool, RAKE)).toEqual({ yes: 1, no: 1 });
  });

  it('quotes a stake-aware indicative payout without locking it', () => {
    const pool: Pool = { yes: 100, no: 300 };
    const q = indicativeQuote(pool, 'YES', 100, RAKE);
    // Post-bet pool: YES 200, NO 300, net 470. This bet owns half YES.
    expect(q.payout).toBeCloseTo(235, 6);
    expect(q.multiple).toBeCloseTo(2.35, 6);
  });

  it('quotes a one-sided book at 1.0x, never a sub-1.0x "win"', () => {
    // Empty book: the first bettor has no opposing stake, so this would settle as a 1.0x refund.
    // The quote must read 1.0x, not stake*(1-rake) (which showed a LOSING multiple on a win).
    const q = indicativeQuote({ yes: 0, no: 0 }, 'YES', 600, RAKE);
    expect(q.multiple).toBe(1);
    expect(q.payout).toBe(600);
  });
});

describe('settlement', () => {
  it('pays winners by final winning-side share and rakes the gross pool', () => {
    const pool: Pool = { yes: 200, no: 300 };
    const bets: Bet[] = [
      { userId: 'u1', side: 'YES', stake: 100 },
      { userId: 'u2', side: 'YES', stake: 100 },
      { userId: 'u3', side: 'NO', stake: 300 },
    ];

    const s = settle(pool, bets, 'YES', RAKE);

    expect(s.rakeTaken).toBeCloseTo(30, 6);
    expect(s.distributable).toBeCloseTo(470, 6);
    expect(s.totalPayouts).toBeCloseTo(470, 6);
    expect(s.operatorPnl).toBeCloseTo(30, 6);
    expect(s.payouts.find((p) => p.userId === 'u1')!.payout).toBeCloseTo(235, 6);
    expect(s.payouts.find((p) => p.userId === 'u2')!.payout).toBeCloseTo(235, 6);
    expect(s.payouts.find((p) => p.userId === 'u3')!.payout).toBe(0);
  });

  it('dilutes early same-side money when later same-side money arrives', () => {
    const earlyPool: Pool = { yes: 0, no: 300 };
    const earlyQuote = indicativeQuote(earlyPool, 'YES', 100, RAKE);
    expect(earlyQuote.multiple).toBeCloseTo(3.76, 6);

    const finalPool: Pool = { yes: 1100, no: 300 };
    const bets: Bet[] = [
      { userId: 'early', side: 'YES', stake: 100 },
      { userId: 'whale', side: 'YES', stake: 1000 },
      { userId: 'loser', side: 'NO', stake: 300 },
    ];
    const s = settle(finalPool, bets, 'YES', RAKE);
    const early = s.payouts.find((p) => p.userId === 'early')!;

    // Final net is 1316; early owns 100/1100 of the winning side.
    expect(early.payout).toBeCloseTo((100 / 1100) * 1316, 6);
    expect(early.payout).toBeLessThan(100 * earlyQuote.multiple);
  });

  it('VOID refunds every stake and takes no rake', () => {
    const pool: Pool = { yes: 40, no: 60 };
    const bets: Bet[] = [
      { userId: 'u1', side: 'YES', stake: 40 },
      { userId: 'u2', side: 'NO', stake: 60 },
    ];
    const s = settle(pool, bets, 'VOID', RAKE);
    expect(s.rakeTaken).toBe(0);
    expect(s.totalPayouts).toBe(0);
    expect(s.payouts.map((p) => p.payout)).toEqual([40, 60]);
  });

  it('VOIDs/refunds a ONE-SIDED WIN at 1.0x — no rake, no self-funded loss', () => {
    // One side backed, that side wins: no counter-pool to win FROM or rake, so each bettor gets
    // their stake back (1.0x) — never stake*(1-rake). Reported VOID (no genuine contest).
    const pool: Pool = { yes: 1000, no: 0 };
    const bets: Bet[] = [
      { userId: 'a', side: 'YES', stake: 600 },
      { userId: 'b', side: 'YES', stake: 400 },
    ];
    const s = settle(pool, bets, 'YES', RAKE);
    expect(s.outcome).toBe('VOID');
    expect(s.rakeTaken).toBe(0);
    expect(s.payouts.find((p) => p.userId === 'a')!.payout).toBe(600);
    expect(s.payouts.find((p) => p.userId === 'b')!.payout).toBe(400);
  });

  it('VOIDs/refunds a ONE-SIDED LOSS too — agrees with the on-chain isOneSidedRealBook void', () => {
    // One side backed, that side LOSES: still no genuine opponent, so REFUND (not forfeit) — the
    // operator voids/refunds this on-chain, so the off-chain settlement must too or the app P&L,
    // the points score, and the real USX wallet would disagree.
    const pool: Pool = { yes: 1000, no: 0 };
    const bets: Bet[] = [{ userId: 'a', side: 'YES', stake: 1000 }];
    const s = settle(pool, bets, 'NO', RAKE);
    expect(s.outcome).toBe('VOID');
    expect(s.payouts.find((p) => p.userId === 'a')!.payout).toBe(1000);
  });
});
