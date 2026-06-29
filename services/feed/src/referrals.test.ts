import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Market } from '@golazo/core';
import { ReferralManager } from './referrals';

/** Valid-looking Solana base58 ids for referral wallet checks. */
const CREATOR = 'acct_11111111111111111111111111111112';
const CREATOR_2 = 'acct_11111111111111111111111111111113';
const REFERRED = 'acct_11111111111111111111111111111114';
const ME = 'acct_11111111111111111111111111111115';
const WALLET_1 = 'acct_11111111111111111111111111111116';

function settledMarket(bets: Market['bets']): Market {
  const yes = bets.filter((b) => b.side === 'YES').reduce((sum, b) => sum + b.stake, 0);
  const no = bets.filter((b) => b.side === 'NO').reduce((sum, b) => sum + b.stake, 0);
  return {
    id: 'mkt_1',
    gameId: 'g1',
    question: 'Next shot?',
    kind: 'next_shot',
    slot: 'versus',
    trueProb: 0.5,
    status: 'resolved',
    pool: { yes, no },
    seedAmount: 0,
    bets,
    openedAt: 1,
    windowMs: 10_000,
    lockAt: 11_000,
    resolveWindowMs: 60_000,
    resolveAt: 71_000,
    settlement: {
      outcome: 'YES',
      rakeTaken: (yes + no) * 0.06,
      distributable: (yes + no) * 0.94,
      totalPayouts: (yes + no) * 0.94,
      operatorPnl: (yes + no) * 0.06,
      payouts: bets.map((b) => ({
        userId: b.userId,
        side: b.side,
        stake: b.stake,
        payout: b.side === 'YES' ? b.stake : 0,
        won: b.side === 'YES',
      })),
    },
  };
}

describe('ReferralManager', () => {
  it('attributes the first valid code and keeps first-touch attribution locked', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    mgr.createCode({ code: 'KOL1', ownerId: CREATOR });
    mgr.createCode({ code: 'KOL2', ownerId: CREATOR_2 });

    const first = mgr.attribute({ userId: REFERRED, code: 'kol1' });
    const second = mgr.attribute({ userId: REFERRED, code: 'kol2' });

    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.attribution?.code).toBe('KOL1');
  });

  it('rejects self-referral on the same wallet id', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    mgr.createCode({ code: 'ME', ownerId: ME });

    const result = mgr.attribute({ userId: ME, code: 'ME' });

    expect(result).toMatchObject({
      ok: false,
      created: false,
      reason: 'cannot use your own code',
    });
  });

  it('rejects non-wallet ids and self-referral on the same wallet', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    const code = mgr.ensureOwnedCode(ME).code;

    expect(mgr.attribute({ userId: 'pts_device42', code }).reason).toBe('wallet account required');
    expect(mgr.attribute({ userId: 'acct_did:privy:foo', code }).reason).toBe('wallet account required');
    expect(mgr.attribute({ userId: ME, code })).toMatchObject({
      ok: false,
      reason: 'cannot use your own code',
    });
  });

  it('does not inflate referred count with ghost alias attributions', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    const code = mgr.ensureOwnedCode(ME).code;
    // Legacy bug: same human attributed under pts + did before wallet was ready.
    mgr['attributions'].set('pts_a', {
      userId: 'pts_a',
      code,
      ownerId: ME,
      attributedAt: 1,
    });
    mgr['attributions'].set(`acct_did:privy:foo`, {
      userId: `acct_did:privy:foo`,
      code,
      ownerId: ME,
      attributedAt: 2,
    });
    mgr.attribute({ userId: REFERRED, code });

    expect(mgr.summary({ ownerId: ME }).attributedUsers).toBe(1);
  });

  it('records 1 percentage point of referred volume as unpaid partner liability', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100, now: () => 123 });
    mgr.createCode({ code: 'KOL', ownerId: CREATOR });
    mgr.attribute({ userId: REFERRED, code: 'KOL' });

    const result = mgr.recordMarketSettlement(
      settledMarket([
        { userId: REFERRED, side: 'YES', stake: 100 },
        { userId: 'acct_11111111111111111111111111111119', side: 'NO', stake: 100 },
      ]),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.totalOwed).toBe(1);
    expect(result.entries[0]).toMatchObject({
      userId: REFERRED,
      code: 'KOL',
      ownerId: CREATOR,
      stake: 100,
      grossFee: 6,
      referrerCut: 1,
      platformNetFee: 5,
      payoutBps: 100,
    });
    expect(mgr.summary({ code: 'KOL' })).toMatchObject({
      volume: 100,
      grossFees: 6,
      referrerEarned: 1,
      referrerUnpaid: 1,
      platformNetFees: 5,
      entries: 1,
    });
  });

  it('auto-provisions a shareable code on profile load', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    const profile = mgr.profile(WALLET_1, 'Alice');
    expect(profile.ownedCodes).toHaveLength(1);
    expect(profile.ownedCodes[0]?.code).toMatch(/^GO[A-Z0-9]+$/);
    expect(mgr.profile(WALLET_1).ownedCodes[0]?.code).toBe(profile.ownedCodes[0]?.code);
  });

  it('is idempotent for the same settled market and can mark unpaid rows paid', () => {
    const mgr = new ReferralManager({ rakeBps: 600, defaultPayoutBps: 100 });
    mgr.createCode({ code: 'KOL', ownerId: CREATOR });
    mgr.attribute({ userId: REFERRED, code: 'KOL' });
    const market = settledMarket([
      { userId: REFERRED, side: 'YES', stake: 250 },
      { userId: 'acct_11111111111111111111111111111119', side: 'NO', stake: 250 },
    ]);

    expect(mgr.recordMarketSettlement(market).totalOwed).toBe(2.5);
    expect(mgr.recordMarketSettlement(market).totalOwed).toBe(0);

    const paid = mgr.markPaid({ code: 'KOL', payoutTx: 'sig_123' });
    expect(paid).toMatchObject({ marked: 1, amount: 2.5 });
    expect(mgr.summary({ code: 'KOL' })).toMatchObject({
      referrerPaid: 2.5,
      referrerUnpaid: 0,
    });
  });

  it('persists through the append journal before snapshot compaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'golazo-ref-'));
    try {
      const storePath = join(dir, 'referrals.snapshot.json');
      const first = new ReferralManager({
        storePath,
        rakeBps: 600,
        defaultPayoutBps: 100,
        now: () => 456,
      });
      first.createCode({ code: 'KOL', ownerId: CREATOR });
      first.attribute({ userId: REFERRED, code: 'KOL' });
      first.recordMarketSettlement(
        settledMarket([{ userId: REFERRED, side: 'YES', stake: 100 }]),
      );

      const second = new ReferralManager({ storePath, rakeBps: 600, defaultPayoutBps: 100 });

      expect(second.summary({ code: 'KOL' })).toMatchObject({
        attributedUsers: 1,
        volume: 100,
        referrerUnpaid: 1,
      });
      expect(second.profile(CREATOR).ownedCodes[0]?.code).toBe('KOL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
