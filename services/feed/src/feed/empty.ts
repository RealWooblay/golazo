import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { FeedSource } from './index';

/**
 * EmptyFeed — the "no live match right now" feed.
 *
 * Used in FEED_MODE=espn when no real game is in play. We deliberately do NOT
 * fall back to the simulator here: the live app must NEVER surface the demo (the
 * demo is reachable only from Profile → Demo match, which runs the sim locally in
 * OFFLINE mode). This feed serves a `pre` game with no teams and emits no events,
 * so the app shows a clean "no live match" state and opens no markets.
 */
const NO_TEAM = (side: 'home' | 'away'): { id: string; name: string; abbr: string } => ({
  id: `none-${side}`,
  name: '—',
  abbr: '—',
});

export class EmptyFeed implements FeedSource {
  readonly kind = 'empty' as const;

  state(): GameState {
    return {
      gameId: 'no-live-match',
      sport: 'soccer',
      league: '',
      home: NO_TEAM('home'),
      away: NO_TEAM('away'),
      scoreHome: 0,
      scoreAway: 0,
      clock: '',
      status: 'pre',
    };
  }

  poll(): FeedEvent[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  applyGoal(_team: Team): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setClock(_clock: string): void {}

  async close(): Promise<void> {}
}
