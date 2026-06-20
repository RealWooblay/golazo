import type { MarketTrigger, OnChainRef, Outcome, Side } from './types';
import {
  type Bet,
  type Pool,
  type Settlement,
  impliedOdds,
  impliedProb,
  grossPool,
  settle,
} from './parimutuel';

/**
 * MarketEngine — the lifecycle state machine for a single game's markets.
 *
 *   open ──(place bets)──▶ locked ──(play resolves)──▶ resolved | void
 *
 * Pure and synchronous: no timers, no I/O. Whoever drives it (the service, or
 * the app in offline mode) owns the clock and calls `lock`/`resolve`. That keeps
 * this fully unit-testable and identical on server and device.
 */

export type MarketStatus = 'open' | 'locked' | 'resolved' | 'void';

export interface Market {
  id: string;
  gameId: string;
  question: string;
  kind: string;
  team?: 'home' | 'away';
  /** model YES prob — drives sim/bot behavior; not shown to users. */
  trueProb: number;
  status: MarketStatus;
  pool: Pool;
  seedAmount: number; // legacy telemetry; pure parimutuel markets keep this at 0
  bets: Bet[];
  openedAt: number;
  windowMs: number;
  lockAt: number; // openedAt + windowMs
  /** Ms after lockAt before force-settle; drives the locked-phase countdown. */
  resolveWindowMs: number;
  /** Absolute deadline for resolution (lockAt + resolveWindowMs). */
  resolveAt: number;
  settlement?: Settlement;
  /**
   * On-chain twin identity, set ONLY in chain mode (the feed operator mirrors
   * each market on Solana). Lets the app derive the program PDAs and place a
   * REAL `place_bet` against this market. Absent → play-money market.
   */
  onChain?: OnChainRef;
}

export interface EngineConfig {
  rake?: number; // default 0.06 (6%)
  baseSeed?: number; // default 0 — no house liquidity in pure parimutuel mode
  now?: () => number; // injectable clock for tests
}

export type EngineEvent = 'open' | 'update' | 'lock' | 'resolve';
type Listener = (m: Market) => void;

export class MarketEngine {
  readonly rake: number;
  readonly baseSeed: number;
  private now: () => number;
  private seq = 0;
  private markets = new Map<string, Market>();
  private listeners: Record<EngineEvent, Set<Listener>> = {
    open: new Set(),
    update: new Set(),
    lock: new Set(),
    resolve: new Set(),
  };

  constructor(cfg: EngineConfig = {}) {
    this.rake = cfg.rake ?? 0.06;
    this.baseSeed = cfg.baseSeed ?? 0;
    this.now = cfg.now ?? (() => Date.now());
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe fn. */
  on(evt: EngineEvent, cb: Listener): () => void {
    this.listeners[evt].add(cb);
    return () => this.listeners[evt].delete(cb);
  }

  private emit(evt: EngineEvent, m: Market) {
    for (const cb of this.listeners[evt]) cb(m);
  }

  get(id: string): Market | undefined {
    return this.markets.get(id);
  }

  list(): Market[] {
    return [...this.markets.values()];
  }

  /** Open a market from a trigger. Pure parimutuel markets start with no house pool. */
  openMarket(t: MarketTrigger): Market {
    const yesSeed = this.baseSeed > 0 ? Math.round(this.baseSeed * t.trueProb) : 0;
    const noSeed = this.baseSeed > 0 ? Math.max(0, this.baseSeed - yesSeed) : 0;
    const openedAt = this.now();
    const lockAt = openedAt + t.windowMs;
    const resolveWindowMs = t.resolveWindowMs ?? 60_000;
    const m: Market = {
      id: `mkt_${++this.seq}`,
      gameId: t.gameId,
      question: t.question,
      kind: t.kind,
      team: t.team,
      trueProb: t.trueProb,
      status: 'open',
      pool: { yes: yesSeed, no: noSeed },
      seedAmount: yesSeed + noSeed,
      bets: [],
      openedAt,
      windowMs: t.windowMs,
      lockAt,
      resolveWindowMs,
      resolveAt: lockAt + resolveWindowMs,
      ...(t.onChain ? { onChain: t.onChain } : {}),
    };
    this.markets.set(m.id, m);
    this.emit('open', m);
    return m;
  }

  /** Current implied odds + prob for a market. */
  odds(id: string) {
    const m = this.must(id);
    return { ...impliedOdds(m.pool, this.rake), prob: impliedProb(m.pool), pool: grossPool(m.pool) };
  }

  /** Place a bet into the live pool. Throws if the market isn't open. */
  placeBet(id: string, userId: string, side: Side, stake: number): Bet {
    const m = this.must(id);
    if (m.status !== 'open') throw new Error(`market ${id} is ${m.status}, not open`);
    if (stake <= 0) throw new Error('stake must be > 0');
    const bet: Bet = { userId, side, stake };
    m.bets.push(bet);
    if (side === 'YES') m.pool.yes += stake;
    else m.pool.no += stake;
    this.emit('update', m);
    return bet;
  }

  /** Close betting. No more stakes accepted after this. */
  lock(id: string): Market {
    const m = this.must(id);
    if (m.status === 'open') {
      m.status = 'locked';
      this.emit('lock', m);
    }
    return m;
  }

  /**
   * Resolve a locked (or still-open) market. `VOID` refunds everyone — use it
   * for any ambiguity, feed fault, or timing violation. Real money + doubt =
   * never guess.
   */
  resolve(id: string, outcome: Outcome): Settlement {
    const m = this.must(id);
    if (m.status === 'open') this.lock(id);
    if (m.status === 'resolved' || m.status === 'void') return m.settlement!;
    const s = settle(m.pool, m.bets, outcome, this.rake, m.seedAmount);
    m.settlement = s;
    m.status = outcome === 'VOID' ? 'void' : 'resolved';
    this.emit('resolve', m);
    return s;
  }

  private must(id: string): Market {
    const m = this.markets.get(id);
    if (!m) throw new Error(`unknown market ${id}`);
    return m;
  }
}
