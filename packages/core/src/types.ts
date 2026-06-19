/**
 * Shared domain types for GOLAZO — the live "bet the play" engine.
 *
 * These types are the contract every layer agrees on:
 *   feed (sim or real) ── FeedEvent ──▶ watcher (AI/rules) ── MarketTrigger ──▶ engine ──▶ Market
 * Keep this file dependency-free; everything else builds on it.
 */

export type Side = 'YES' | 'NO';
export type Outcome = 'YES' | 'NO' | 'VOID';
export type Team = 'home' | 'away';
export type Sport = 'soccer' | 'nfl';

/** A team, normalized across feeds. */
export interface TeamRef {
  id: string;
  name: string; // "Argentina"
  abbr: string; // "ARG"
  color?: string;
}

/** Live state of a game, normalized across feeds. */
export interface GameState {
  gameId: string;
  sport: Sport;
  league: string;
  home: TeamRef;
  away: TeamRef;
  scoreHome: number;
  scoreAway: number;
  clock: string; // display clock, e.g. "28'"
  status: 'pre' | 'live' | 'final';
}

/**
 * A normalized event coming off ANY feed (simulator or a real provider).
 * The whole point of normalizing here is that the watcher + engine never
 * know or care where the event came from.
 */
export type FeedEventType =
  | 'kickoff'
  | 'calm'
  | 'attack'
  | 'dangerous_attack'
  | 'corner'
  | 'free_kick'
  | 'penalty'
  | 'shot'
  | 'goal'
  | 'miss'
  | 'card'
  | 'snap'
  | 'play_end'
  | 'final';

export interface FeedEvent {
  gameId: string;
  ts: number; // epoch ms (feed time)
  type: FeedEventType;
  team?: Team;
  text: string; // human commentary
  meta?: Record<string, unknown>;
}

/**
 * Emitted by the watcher (AI or rule layer) when an event is judged a
 * *bettable moment*. This is the only thing the engine consumes to open a market.
 */
/** Identifies a market's on-chain twin: the operator authority + its market_seed. */
export interface OnChainRef {
  /** u64 market_seed used in the program's market PDA seeds. */
  marketSeed: number;
  /** base58 operator pubkey that is the on-chain market `authority`. */
  authority: string;
}

export interface MarketTrigger {
  gameId: string;
  question: string; // "Argentina on the attack — GOAL?"
  kind: string; // 'goal_from_open_play' | 'penalty_scored' | 'corner_goal' | ...
  team?: Team;
  windowMs: number; // betting window length
  /**
   * Model estimate of the YES probability. Used to seed the pool so opening
   * odds are sane, and (in the simulator only) to resolve the outcome.
   * NEVER shown to users — they price it themselves via the pool.
   */
  trueProb: number;
  /** Set in chain mode: the on-chain twin the app should place REAL bets on. */
  onChain?: OnChainRef;
}
