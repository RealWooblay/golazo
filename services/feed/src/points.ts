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

/**
 * House liquidity (in points) seeded into EACH paper market when it opens, split by
 * the model's YES probability. Without it a solo bettor faces an EMPTY pool: a
 * winning bet only refunds the stake (there's no opposing money to win FROM) and the
 * displayed odds are fictional. The seed gives every market a real two-sided book
 * from bet one — live odds that actually match the payout — without ever crediting a
 * real player: the seed lives only in the pool totals, never as a `bets` entry, so on
 * settle the house's losing-side stake funds the winners and its winning-side stake is
 * simply absorbed. Sized for a 500-point bankroll and 10–100 stakes.
 */
export const HOUSE_SEED_POINTS = 150;

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
  /** Stakes reserved during the anti-latency hold (deducted, not yet in pool). */
  private readonly heldStakes = new Map<string, { userId: string; side: Side; stake: number }>();

  private holdKey(marketId: string, userId: string): string {
    return `${marketId}:${userId}`;
  }

  private betPlacementError(
    userId: string,
    marketId: string,
    stake: number,
    player: PointsPlayer | undefined,
    pm: PointsMarket | undefined,
  ): PointsEffects['rejected'] | undefined {
    if (!player) {
      return { userId, marketId, stake, reason: 'join play mode first' };
    }
    if (!pm || pm.status !== 'open') {
      return { userId, marketId, stake, reason: 'market not open' };
    }
    if (Date.now() >= bettingClosesAt(pm.lockAt, pm.windowMs)) {
      return { userId, marketId, stake, reason: 'betting window closing' };
    }
    if (stake <= 0 || !Number.isFinite(stake)) {
      return { userId, marketId, stake, reason: 'invalid stake' };
    }
    if (pm.bets.some((b) => b.userId === userId)) {
      return { userId, marketId, stake, reason: 'one bet per market' };
    }
    if (this.heldStakes.has(this.holdKey(marketId, userId))) {
      return { userId, marketId, stake, reason: 'bet already pending' };
    }
    if (stake > player.balance) {
      return { userId, marketId, stake, reason: 'not enough points' };
    }
    return undefined;
  }

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
    // Seed house liquidity split by the model's YES prob so the book is two-sided
    // and a winner is paid real points out of the house's opposing stake. Clamp the
    // prob so neither side is ever starved (which would mean absurd one-sided odds).
    const p = Math.min(0.85, Math.max(0.15, m.trueProb || 0.5));
    const seedYes = Math.round(HOUSE_SEED_POINTS * p);
    this.markets.set(m.id, {
      id: m.id,
      status: 'open',
      pool: { yes: seedYes, no: HOUSE_SEED_POINTS - seedYes },
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

  /** Reserve stake during the bet-delay hold (balance deducted immediately). */
  holdBet(userId: string, marketId: string, side: Side, stake: number): PointsEffects {
    const player = this.players.get(userId);
    const pm = this.markets.get(marketId);
    const err = this.betPlacementError(userId, marketId, stake, player, pm);
    if (err) return { rejected: err };

    player!.balance -= stake;
    this.heldStakes.set(this.holdKey(marketId, userId), { userId, side, stake });
    return this.effectsFor(userId, true);
  }

  /** Bet-delay elapsed — move the held stake into the parimutuel pool. */
  confirmHeldBet(userId: string, marketId: string): PointsEffects {
    const key = this.holdKey(marketId, userId);
    const held = this.heldStakes.get(key);
    const pm = this.markets.get(marketId);
    if (!held) return {};
    if (!pm || pm.status === 'resolved' || pm.status === 'void') {
      return this.releaseHeldBet(userId, marketId, 'play resolved before your bet cleared');
    }
    // Stake was reserved while betting was open — locking closes new bets, not
    // holds that already cleared the anti-snipe window.

    this.heldStakes.delete(key);
    pm.bets.push({ userId: held.userId, side: held.side, stake: held.stake });
    if (held.side === 'YES') pm.pool.yes += held.stake;
    else pm.pool.no += held.stake;

    return {
      ...this.effectsFor(userId, true),
      marketUpdate: snapshotPointsMarket(pm),
    };
  }

  /** Held bet could not land — refund the reserved stake. */
  releaseHeldBet(userId: string, marketId: string, reason: string): PointsEffects {
    const key = this.holdKey(marketId, userId);
    const held = this.heldStakes.get(key);
    if (!held) return {};

    this.heldStakes.delete(key);
    const player = this.players.get(userId);
    if (player) player.balance += held.stake;

    return {
      rejected: { userId, marketId, stake: held.stake, reason },
      ...this.effectsFor(userId, true),
    };
  }

  placeBet(userId: string, marketId: string, side: Side, stake: number): PointsEffects {
    const player = this.players.get(userId);
    const pm = this.markets.get(marketId);
    const err = this.betPlacementError(userId, marketId, stake, player, pm);
    if (err) return { rejected: err };

    player!.balance -= stake;
    pm!.bets.push({ userId, side, stake });
    if (side === 'YES') pm!.pool.yes += stake;
    else pm!.pool.no += stake;

    return {
      ...this.effectsFor(userId, true),
      marketUpdate: snapshotPointsMarket(pm!),
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
