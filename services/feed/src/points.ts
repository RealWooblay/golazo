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
  shouldMergeAccountIds,
  type Market,
  type Outcome,
  type PointsMarket,
  type PointsMarketSnapshot,
  type PointsPlayer,
  type Side,
} from '@golazo/core';
import { bettingClosesAt } from './ai/marketTuning';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * PUBLIC-SAFE display name for the leaderboard. The board is public, so a name must NEVER
 * leak PII — no emails, no phone numbers, nothing that doxxes a user. A real chosen handle
 * passes through (control chars stripped, length-capped). Empty, bare "Player", email,
 * or phone-shaped strings become the anonymous label `Player` — never PII, never wallet
 * fragments. Applied on register (input), on load, AND on leaderboard output.
 */
export function safeDisplayName(raw: string | undefined, _userId: string): string {
  const cleaned = (raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const looksLikeEmail = cleaned.includes('@');
  const looksLikePhone = /(?:\+?\d[\s\-().]*){7,}/.test(cleaned);
  if (looksLikeEmail || looksLikePhone || cleaned === '' || cleaned.toLowerCase() === 'player') {
    return 'Player';
  }
  return cleaned.slice(0, 24);
}

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
  /** Monotonic id source for house-liquidity bot bets. */
  private botSeq = 0;

  /**
   * Optional disk path for balance persistence. Without it the leaderboard is pure
   * in-memory and a process restart/redeploy resets everyone to START — which is the
   * "I won, then my points reset" bug. With it, balances survive restarts: loaded on
   * construct, snapshotted on a timer and immediately after every settlement.
   */
  constructor(private readonly storePath?: string) {
    this.load();
    if (storePath) {
      // Tiny file, few players — a periodic snapshot is plenty. unref'd so it never
      // keeps the process alive (settlements flush eagerly anyway).
      const timer = setInterval(() => this.flush(), 5_000);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  private load(): void {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const rows = JSON.parse(readFileSync(this.storePath, 'utf8')) as PointsPlayer[];
      for (const p of rows) {
        if (!p?.userId) continue;
        this.players.set(p.userId, {
          userId: p.userId,
          // Sanitize legacy rows — an older build may have persisted an email as the name.
          name: safeDisplayName(p.name, p.userId),
          balance: Number.isFinite(p.balance) ? p.balance : POINTS_START_BALANCE,
          connected: false,
          joinedAt: p.joinedAt || Date.now(),
        });
      }
      console.log(`[golazo/points] restored ${this.players.size} balances from ${this.storePath}`);
    } catch (e) {
      console.warn(`[golazo/points] could not read points store: ${(e as Error).message}`);
    }
  }

  /** Snapshot balances to disk (periodic + right after each settlement). No-op if unconfigured. */
  flush(): void {
    if (!this.storePath) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      // Persist ONLY logged-in players (acct_*) — anonymous device sessions are ephemeral and
      // shouldn't accumulate in the store. Their balances survive a reconnect within a process
      // (in-memory), but a logged-in account is the durable, cross-device identity.
      const rows = [...this.players.values()]
        .filter((p) => p.userId.startsWith('acct_'))
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          balance: p.balance,
          joinedAt: p.joinedAt,
          connected: false,
        }));
      writeFileSync(this.storePath, JSON.stringify(rows));
    } catch (e) {
      console.warn(`[golazo/points] could not persist points store: ${(e as Error).message}`);
    }
  }

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

  register(userId: string, name: string, priorUserId?: string): PointsEffects {
    const safe = safeDisplayName(name, userId);
    if (priorUserId && shouldMergeAccountIds(priorUserId, userId)) {
      this.mergePlayer(priorUserId, userId, safe);
    } else {
      const existing = this.players.get(userId);
      if (existing) {
        existing.name = safe;
        existing.connected = true;
      } else {
        this.players.set(userId, {
          userId,
          name: safe,
          balance: POINTS_START_BALANCE,
          connected: true,
          joinedAt: Date.now(),
        });
      }
    }
    return this.effectsFor(userId, true);
  }

  /** Fold a legacy anonymous session into the durable account id (one row on the board). */
  private mergePlayer(fromUserId: string, toUserId: string, name: string): void {
    const from = this.players.get(fromUserId);
    const to = this.players.get(toUserId);
    const safe = safeDisplayName(name, toUserId);
    if (from && to) {
      to.balance += from.balance;
      to.name = safe;
      to.connected = true;
      this.players.delete(fromUserId);
      return;
    }
    if (from && !to) {
      this.players.set(toUserId, {
        ...from,
        userId: toUserId,
        name: safe,
        connected: true,
      });
      this.players.delete(fromUserId);
      return;
    }
    const existing = this.players.get(toUserId);
    if (existing) {
      existing.name = safe;
      existing.connected = true;
    } else {
      this.players.set(toUserId, {
        userId: toUserId,
        name: safe,
        balance: POINTS_START_BALANCE,
        connected: true,
        joinedAt: Date.now(),
      });
    }
  }

  disconnect(userId: string): PointsEffects {
    const p = this.players.get(userId);
    if (p) p.connected = false;
    return { leaderboard: this.leaderboard() };
  }

  onMarketOpen(m: Market): void {
    if (this.markets.has(m.id)) return;
    // NO house seed. The points pool is PURE real user money: the multiple moves only as
    // players back each side (parimutuel), exactly mirroring the on-chain program. A market
    // that draws money on only one side settles VOID/refund (see settlePointsMarket) — a
    // winner is never paid out of phantom house liquidity.
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

    this.flush(); // persist winnings immediately — a redeploy must never reset a win
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
    this.flush(); // persist cross-mode points moved by a real-bet settlement
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

  /** Current implied YES probability from the points pool (drives bot leaning). */
  marketImpliedYes(marketId: string): number | undefined {
    const pm = this.markets.get(marketId);
    if (!pm) return undefined;
    const gross = pm.pool.yes + pm.pool.no;
    return gross > 0 ? pm.pool.yes / gross : 0.5;
  }

  /**
   * HOUSE LIQUIDITY bet — random two-sided money so a points market's multiple actually
   * MOVES and is meaningful (the fixed seed alone pins it near ~1.1x). No player/balance
   * checks (bots have no balance); tracked in `bets` under a synthetic `pbot_*` id so on
   * settle the bots' LOSING side funds real winners and their winning share is absorbed
   * (a `pbot_*` id isn't a registered player, so no balance is ever credited). Returns the
   * marketUpdate so the live pool/odds broadcast to clients exactly like a human bet.
   */
  placeBotBet(marketId: string, side: Side, stake: number): PointsEffects {
    const pm = this.markets.get(marketId);
    if (!pm || pm.status !== 'open' || stake <= 0) return {};
    pm.bets.push({ userId: `pbot_${(this.botSeq++).toString(36)}`, side, stake });
    if (side === 'YES') pm.pool.yes += stake;
    else pm.pool.no += stake;
    return { marketUpdate: snapshotPointsMarket(pm) };
  }

  /**
   * Only LOGGED-IN players appear on the leaderboard. A logged-in (Privy) user's id is prefixed
   * `acct_` (see the mobile usePointsIdentity); an anonymous device player (`pts_*`) can still
   * play + see their own balance, but is never ranked. So "not logged in → not on the board".
   */
  leaderboard(limit = 50): PointsPlayer[] {
    return [...this.players.values()]
      .filter((p) => p.userId.startsWith('acct_'))
      .sort((a, b) => b.balance - a.balance || a.joinedAt - b.joinedAt)
      .slice(0, limit)
      // Final guard at the public boundary: never emit a name that could doxx a user,
      // even if a legacy/in-memory row somehow still holds PII.
      .map((p) => ({ ...p, name: safeDisplayName(p.name, p.userId) }));
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
