/**
 * ESPN REPLAY feed — replays a REAL match's play-by-play in TRUE chronological
 * order, with ZERO lookahead, so the watcher must identify opportunities live —
 * exactly as it would on a real in-progress match.
 *
 * THE RULE THAT MAKES THIS HONEST: we emit the real `commentary` + `keyEvents`
 * strictly in the order they occurred. The watcher sees each event as it lands
 * and decides "is this a bettable opportunity?" WITHOUT seeing anything later.
 *   • "Penalty/corner/free-kick awarded", "dangerous attack building" → opens a
 *     market (outcome genuinely unknown at this point).
 *   • A later "goal"/"saved"/"miss" resolves it; if nothing decides it inside the
 *     window, the orchestrator settles NO (the chance passed) — never peeking.
 *
 * We do NOT fabricate opportunities from known goals. The only transformation is
 * compressing match-minutes to wall-clock so ~90' replays in a couple of minutes.
 *
 * A genuinely live match uses `EspnFeed`, which is no-lookahead by nature (it can
 * only ever return events that have already been published). This replay is a
 * faithful stand-in for when no match is currently in play.
 */

import type { FeedEvent, GameState, Team } from '@golazo/core';
import type { FeedSource } from './index';
import {
  mapKeyEventType,
  classifyCommentary,
  isAiCommentaryProbe,
  parseGameState,
  parseClockKey,
  type EspnKeyEvent,
  type EspnCommentary,
  type EspnSummary,
  type EspnScoreboard,
} from './espn';
import { classifyResolverCommentary } from '../ai/marketTuning';

/** Event types that OPEN a market — ordered before same-clock resolvers. */
const OPENER_SET: ReadonlySet<FeedEvent['type']> = new Set([
  'penalty',
  'corner',
  'free_kick',
  'attack',
  'dangerous_attack',
  'var_check',
]);

const SCOREBOARD = (league: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;
const SUMMARY = (league: string, id: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(id)}`;

/** Default wall-clock ms per one minute of match time (replay speed). */
const DEFAULT_MS_PER_GAME_MIN = 1300;

interface TimelineItem {
  atMs: number; // wall-clock offset from replay start
  ev: FeedEvent;
  minute: number;
}

export interface ReplayOptions {
  league: string;
  eventId: string;
  fetchImpl?: typeof fetch;
  /**
   * Wall-clock ms per match-minute. Default compresses ~90' into ~2 min for demos.
   * The full-game SIM passes 60_000 (real-time spacing) so market windows behave
   * exactly as they do in production and outcomes resolve faithfully.
   */
  msPerGameMin?: number;
}

export class EspnReplayFeed implements FeedSource {
  readonly kind = 'replay' as const;
  private readonly league: string;
  private readonly eventId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly msPerGameMin: number;

  private gameState: GameState = placeholder();
  private homeTeamId?: string;
  private awayTeamId?: string;
  private timeline: TimelineItem[] = [];
  private cursor = 0;
  private startedAt = 0;
  private seq = 0;

  constructor(opts: ReplayOptions) {
    this.league = opts.league;
    this.eventId = opts.eventId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.msPerGameMin = opts.msPerGameMin ?? DEFAULT_MS_PER_GAME_MIN;
  }

  async start(): Promise<boolean> {
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    const ev = board?.events?.find((e) => e.id === this.eventId) ?? board?.events?.[0];
    if (!ev) return false;
    const parsed = parseGameState(ev);
    if (!parsed) return false;
    this.gameState = { ...parsed.state, scoreHome: 0, scoreAway: 0, status: 'live', clock: "0'" };
    this.homeTeamId = parsed.homeTeamId;
    this.awayTeamId = parsed.awayTeamId;

    const summary = await this.getJson<EspnSummary>(SUMMARY(this.league, ev.id!));
    if (!summary) return false;

    this.buildChronologicalTimeline(summary);
    this.startedAt = Date.now();
    return this.timeline.length > 0;
  }

  state(): GameState {
    return this.gameState;
  }

  poll(now: number = Date.now()): FeedEvent[] {
    const elapsed = now - this.startedAt;
    const out: FeedEvent[] = [];
    while (this.cursor < this.timeline.length && this.timeline[this.cursor]!.atMs <= elapsed) {
      const item = this.timeline[this.cursor]!;
      this.cursor++;
      if (item.ev.type === 'goal' && item.ev.team) {
        if (item.ev.team === 'home') this.gameState.scoreHome++;
        else this.gameState.scoreAway++;
      }
      if (item.minute > 0) this.gameState.clock = `${item.minute}'`;
      out.push(item.ev);
    }
    if (this.cursor >= this.timeline.length && this.gameState.status === 'live') {
      this.gameState.status = 'final';
    }
    return out;
  }

  applyGoal(_team: Team): void {
    /* scoreline advances from the timeline itself (see poll) */
  }
  setClock(clock: string): void {
    this.gameState.clock = clock;
  }
  async close(): Promise<void> {
    this.timeline = [];
    this.cursor = 0;
  }

  // -------------------------------------------------------------------------

  /**
   * Merge commentary + keyEvents into ONE list ordered by match time, mapped to
   * FeedEvents via the SAME normalizers the live feed uses. No pairing, no
   * lookahead — the watcher gets the real stream in real order.
   *
   * Ordering within a minute: commentary BEFORE keyEvents, because the build-up
   * line ("penalty awarded", "breaks through") naturally precedes the structured
   * outcome ("Penalty - Scored") — so an opportunity can open before it resolves.
   */
  private buildChronologicalTimeline(summary: EspnSummary): void {
    type Raw = { key: number; minute: number; rank: number; order: number; ev: FeedEvent };
    const raws: Raw[] = [];
    // Clock sort-key folds stoppage in: "45'"→45.00, "45+2'"→45.02 (45 < 45+2 < 46).
    const keyOf = (clock?: string) => {
      const { base, stopp } = parseClockKey(clock);
      return { key: base + stopp / 100, minute: base };
    };
    const rankOf = (t: FeedEvent['type']) => (OPENER_SET.has(t) ? 0 : 1);

    (summary.commentary ?? []).forEach((c: EspnCommentary, i) => {
      // Mirror the LIVE feed's normalization chain exactly, so a replay produces
      // the SAME event stream the watcher sees in production: opener → resolver
      // (shots/saves/clears) → fuzzy AI-probe attack. Previously replay only ran
      // `classifyCommentary`, silently dropping every "Attempt …" / build-up line.
      const text = c.text ?? '';
      let type = classifyCommentary(text);
      if (!type) type = classifyResolverCommentary(text);
      if (!type && isAiCommentaryProbe(text)) type = 'attack';
      if (!type) return;
      const { key, minute } = keyOf(c.time?.displayValue);
      raws.push({
        key,
        minute,
        rank: rankOf(type),
        order: i,
        ev: this.feedEvent(type, (c.text ?? '').slice(0, 100), this.teamFromText(c.text)),
      });
    });

    (summary.keyEvents ?? []).forEach((ke: EspnKeyEvent, i) => {
      const type = mapKeyEventType(ke);
      if (!type) return;
      const { key, minute } = keyOf(ke.clock?.displayValue);
      raws.push({
        key,
        minute,
        rank: rankOf(type),
        order: 1000 + i,
        ev: this.feedEvent(type, ke.text || ke.type?.text || type, this.teamSide(ke.team?.id)),
      });
    });

    // Sort by clock (stoppage-aware), then OPENERS before same-clock resolvers,
    // then source order — so an opportunity is never emitted after its outcome.
    raws.sort((a, b) => a.key - b.key || a.rank - b.rank || a.order - b.order);

    this.timeline = raws.map((r) => ({
      atMs: Math.max(0, r.key * this.msPerGameMin),
      minute: r.minute,
      ev: r.ev,
    }));
  }

  private feedEvent(type: FeedEvent['type'], text: string, team: Team | undefined): FeedEvent {
    return {
      gameId: this.eventId,
      ts: 0,
      type,
      ...(team ? { team } : {}),
      text,
      meta: { source: 'espn.replay', noLookahead: true },
    };
  }

  private teamSide(id: string | undefined): Team | undefined {
    if (!id) return undefined;
    if (id === this.homeTeamId) return 'home';
    if (id === this.awayTeamId) return 'away';
    return undefined;
  }

  /** Best-effort team attribution from a commentary line (it names the team). */
  private teamFromText(text: string | undefined): Team | undefined {
    if (!text) return undefined;
    const t = text.toLowerCase();
    if (this.gameState.home.name && t.includes(this.gameState.home.name.toLowerCase())) return 'home';
    if (this.gameState.away.name && t.includes(this.gameState.away.name.toLowerCase())) return 'away';
    return undefined;
  }

  private async getJson<T>(url: string): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function placeholder(): GameState {
  return {
    gameId: 'replay-pending',
    sport: 'soccer',
    league: 'FIFA World Cup',
    home: { id: 'home', name: 'Home', abbr: 'HOM' },
    away: { id: 'away', name: 'Away', abbr: 'AWY' },
    scoreHome: 0,
    scoreAway: 0,
    clock: "0'",
    status: 'pre',
  };
}
