/**
 * POINTS manager — authoritative points balances + a paper parimutuel pool per
 * live market, PLUS a cross-mode score: real-money bets feed the same balances.
 *
 * Points are one universal skill score. Paper bets move points through the
 * parimutuel pool here; real bets move the SAME points by their net result on
 * resolve (see awardRealBet). The real-money pool itself is untouched — only the
 * bettor's points score is credited/debited so both modes share one leaderboard.
 */
import {
  POINTS_START_BALANCE,
  POINTS_REFILL_COOLDOWN_MS,
  POINTS_REFILL_THRESHOLD,
  realBetPointsDelta,
  settlePointsMarket,
  snapshotPointsMarket,
  type Market,
  type Outcome,
  type PointsMarket,
  type PointsMarketSnapshot,
  type PointsPlayer,
  type Side,
} from '@golazo/core';
import { bettingClosesAt } from './ai/marketTuning';

export interface PointsEffects {
  state?: { userId: string; balance: number; rank: number };
  leaderboard?: PointsPlayer[];
  marketUpdate?: PointsMarketSnapshot;
  rejected?: { userId: string; marketId: string; stake: number; reason: string };
  refillRejected?: { userId: string; reason: string };
  settled?: {
    userId: string;
    marketId: string;
    payout: number;
    outcome: Outcome;
    balance: number;
  }[];
}

export class PointsManager {
  private readonly players = new Map<string, PointsPlayer>();
  private readonly markets = new Map<string, PointsMarket>();
  private readonly lastRefill = new Map<string, number>();

  register(userId: string, name: string): PointsEffects {
    const existing = this.players.get(userId);
    if (existing) {
      existing.name = name.trim() || existing.name;
      existing.connected = true;
    } else {
      this.players.set(userId, {
        userId,
        name: name.trim() || 'Player',
        balance: POINTS_START_BALANCE,
        connected: true,
        joinedAt: Date.now(),
      });
    }
    return this.effectsFor(userId, true);
  }

  disconnect(userId: string): PointsEffects {
    const p = this.players.get(userId);
    if (p) p.connected = false;
    return { leaderboard: this.leaderboard() };
  }

  onMarketOpen(m: Market): void {
    if (this.markets.has(m.id)) return;
    this.markets.set(m.id, {
      id: m.id,
      status: 'open',
      pool: { yes: 0, no: 0 },
      openedAt: m.openedAt,
      lockAt: m.lockAt,
      windowMs: m.windowMs,
      bets: [],
    });
  }

  /** Catch up a late joiner with markets already open on the feed. */
  syncMarket(m: Market): PointsMarketSnapshot | undefined {
    if (m.status === 'resolved' || m.status === 'void') return undefined;
    if (!this.markets.has(m.id)) this.onMarketOpen(m);
    if (m.status === 'locked') this.onMarketLock(m.id);
    const pm = this.markets.get(m.id);
    return pm ? snapshotPointsMarket(pm) : undefined;
  }

  onMarketLock(marketId: string): void {
    const pm = this.markets.get(marketId);
    if (pm && pm.status === 'open') pm.status = 'locked';
  }

  onMarketResolve(m: Market): PointsEffects {
    const pm = this.markets.get(m.id);
    if (!pm) return {};
    const outcome = m.settlement?.outcome;
    if (!outcome) return {};

    const settlement = settlePointsMarket(pm, outcome);
    const settled: PointsEffects['settled'] = [];

    for (const pay of settlement.payouts) {
      const player = this.players.get(pay.userId);
      if (!player) continue;
      player.balance += pay.payout;
      settled.push({
        userId: pay.userId,
        marketId: m.id,
        payout: pay.payout,
        outcome: settlement.outcome,
        balance: player.balance,
      });
    }

    pm.outcome = settlement.outcome;
    pm.status = settlement.outcome === 'VOID' ? 'void' : 'resolved';

    return {
      settled,
      leaderboard: this.leaderboard(),
    };
  }

  /**
   * REAL-MODE → points: on a settled real-money market, move each registered
   * bettor's cross-mode points score by their net result (win → +, lose → −).
   * Skips VOID (net-zero refund) and any payout whose userId isn't a points
   * player (e.g. bots, or real bettors who never joined the points system).
   * The real-money pool is NOT touched here — only the points balance.
   */
  awardRealBet(m: Market): PointsEffects {
    const settlement = m.settlement;
    if (!settlement || settlement.outcome === 'VOID') return {};

    const settled: PointsEffects['settled'] = [];
    for (const pay of settlement.payouts) {
      const player = this.players.get(pay.userId);
      if (!player) continue; // bot or non-points bettor — no cross-mode score
      const delta = realBetPointsDelta(pay);
      if (delta === 0) continue;
      player.balance += delta;
      settled.push({
        userId: pay.userId,
        marketId: m.id,
        // Report the points-balance delta as the "payout" so the client reveal
        // shows the score change; outcome mirrors the real market's outcome.
        payout: delta,
        outcome: settlement.outcome,
        balance: player.balance,
      });
    }

    if (settled.length === 0) return {};
    return { settled, leaderboard: this.leaderboard() };
  }

  /** Paper-trade top-up when balance is low. Not real money. */
  refill(userId: string): PointsEffects {
    const player = this.players.get(userId);
    if (!player) {
      return { refillRejected: { userId, reason: 'join paper mode first' } };
    }
    if (player.balance >= POINTS_REFILL_THRESHOLD) {
      return {
        refillRejected: {
          userId,
          reason: `still have ${player.balance} pts — refill below ${POINTS_REFILL_THRESHOLD}`,
        },
      };
    }
    const last = this.lastRefill.get(userId) ?? 0;
    const wait = POINTS_REFILL_COOLDOWN_MS - (Date.now() - last);
    if (wait > 0) {
      return {
        refillRejected: {
          userId,
          reason: `wait ${Math.ceil(wait / 1000)}s before refilling again`,
        },
      };
    }
    player.balance = POINTS_START_BALANCE;
    this.lastRefill.set(userId, Date.now());
    return this.effectsFor(userId, true);
  }

  placeBet(userId: string, marketId: string, side: Side, stake: number): PointsEffects {
    const player = this.players.get(userId);
    if (!player) {
      return {
        rejected: { userId, marketId, stake, reason: 'join play mode first' },
      };
    }
    const pm = this.markets.get(marketId);
    if (!pm || pm.status !== 'open') {
      return { rejected: { userId, marketId, stake, reason: 'market not open' } };
    }
    if (Date.now() >= bettingClosesAt(pm.lockAt, pm.windowMs)) {
      return { rejected: { userId, marketId, stake, reason: 'betting window closing' } };
    }
    if (stake <= 0 || !Number.isFinite(stake)) {
      return { rejected: { userId, marketId, stake, reason: 'invalid stake' } };
    }
    if (pm.bets.some((b) => b.userId === userId)) {
      return { rejected: { userId, marketId, stake, reason: 'one bet per market' } };
    }
    if (stake > player.balance) {
      return { rejected: { userId, marketId, stake, reason: 'not enough points' } };
    }

    player.balance -= stake;
    pm.bets.push({ userId, side, stake });
    if (side === 'YES') pm.pool.yes += stake;
    else pm.pool.no += stake;

    return {
      ...this.effectsFor(userId, true),
      marketUpdate: snapshotPointsMarket(pm),
    };
  }

  leaderboard(limit = 50): PointsPlayer[] {
    return [...this.players.values()]
      .sort((a, b) => b.balance - a.balance || a.joinedAt - b.joinedAt)
      .slice(0, limit);
  }

  rankOf(userId: string): number {
    const board = this.leaderboard(500);
    const idx = board.findIndex((p) => p.userId === userId);
    return idx < 0 ? board.length + 1 : idx + 1;
  }

  private effectsFor(userId: string, includeBoard: boolean): PointsEffects {
    const p = this.players.get(userId);
    if (!p) return {};
    return {
      state: { userId, balance: p.balance, rank: this.rankOf(userId) },
      ...(includeBoard ? { leaderboard: this.leaderboard() } : {}),
    };
  }
}
