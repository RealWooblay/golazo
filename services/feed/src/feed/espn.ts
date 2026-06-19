/**
 * ESPN feed adapter — a REAL live soccer feed normalized into core `FeedEvent`s.
 *
 * ================================================================
 * ENDPOINTS (ESPN's free, unofficial, key-less JSON API)
 * ================================================================
 * 1. Scoreboard — find a game that is currently live:
 *      GET https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard
 *    `events[]` each have `status.type.state` ∈ 'pre' | 'in' | 'post'. We pick
 *    the first event in state 'in'. Each event also carries the two competitors
 *    (home/away), names, abbreviations, and the live score.
 *
 * 2. Summary — key plays / commentary for a specific event:
 *      GET https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary?event={id}
 *    We read two arrays and merge them by clock:
 *      - `commentary[]` : timestamped natural-language play-by-play (rich text).
 *      - `keyEvents[]`  : structured highlights (goals, cards, subs, etc.) with a
 *                         `type.id`/`type.text` we can map deterministically.
 *
 * ================================================================
 * NORMALIZATION (ESPN -> FeedEventType)
 * ================================================================
 * Structured `keyEvents` (preferred — unambiguous):
 *   Goal / "Goal"            -> 'goal'
 *   Penalty - Scored         -> 'goal'   (preceded by a 'penalty' attack event)
 *   Penalty - Missed/Saved   -> 'miss'
 *   Penalty awarded          -> 'penalty'
 *   Yellow/Red Card          -> 'card'
 *   Corner                   -> 'corner'
 *   Free kick / Foul (att.)  -> 'free_kick'
 *   Shot on/off target/Saved -> 'shot' or 'miss' (a saved/blocked shot resolves NO)
 *
 * Free-text `commentary` (fallback — heuristic):
 *   We never invent a goal from prose (goals always come from keyEvents, which
 *   are authoritative). Instead we read prose ONLY to detect promising build-up:
 *     "dangerous", "through ball", "counter", "breaks", "one-on-one", "clear chance"
 *       -> 'dangerous_attack'
 *     "attack", "forward", "into the box", "pressure", "building"
 *       -> 'attack'
 *   These are the "set moments" the watcher opens a market on. The matching
 *   structured goal/miss keyEvent (correlated by sequenceId) resolves it later.
 *
 * Every emitted event carries `meta.sequenceId` so the orchestrator can pair an
 * attack with the goal/miss that decides it — exactly like the simulator does.
 *
 * ================================================================
 * RESILIENCE
 * ================================================================
 * No live game, HTTP errors, rate limits (429), malformed JSON, timeouts — all
 * are handled here and surfaced as "no events / not live". The factory in
 * index.ts treats an unavailable ESPN feed as a signal to fall back to the sim.
 */

import type { FeedEvent, FeedEventType, GameState, Team, TeamRef } from '@golazo/core';
import type { FeedSource } from './index';
import { COMMENTARY_PATTERNS } from '../ai/marketTuning';

const SCOREBOARD = (league: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;
const SUMMARY = (league: string, eventId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(eventId)}`;

/** Network timeout for any single ESPN request. */
const FETCH_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// Minimal structural types for the bits of the ESPN payload we actually read.
// ESPN's API is unofficial and richly nested; we type only what we touch and
// treat everything else as unknown so a schema change degrades gracefully.
// ---------------------------------------------------------------------------

export interface EspnCompetitor {
  homeAway?: 'home' | 'away';
  score?: string;
  team?: { id?: string; displayName?: string; abbreviation?: string; color?: string };
}
export interface EspnStatus {
  type?: { state?: 'pre' | 'in' | 'post'; completed?: boolean };
  displayClock?: string;
  clock?: number;
}
export interface EspnEvent {
  id?: string;
  status?: EspnStatus;
  competitions?: { competitors?: EspnCompetitor[] }[];
}
export interface EspnScoreboard {
  events?: EspnEvent[];
}
export interface EspnCommentary {
  sequence?: number | string;
  time?: { displayValue?: string };
  text?: string;
}
export interface EspnKeyEvent {
  id?: string | number;
  sequence?: number | string;
  type?: { id?: string | number; text?: string };
  text?: string;
  clock?: { displayValue?: string };
  team?: { id?: string };
  scoringPlay?: boolean;
}
export interface EspnSummary {
  commentary?: EspnCommentary[];
  keyEvents?: EspnKeyEvent[];
}

/** A live game we've locked onto: its id plus the resolved team identities. */
interface LiveGame {
  eventId: string;
  state: GameState;
  homeTeamId: string | undefined;
  awayTeamId: string | undefined;
}

export interface EspnFeedOptions {
  league: string;
  /** Override for tests; defaults to global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
}

export class EspnFeed implements FeedSource {
  readonly kind = 'espn' as const;
  private readonly league: string;
  private readonly fetchImpl: typeof fetch;

  /** The game we're tracking, once `start()` finds a live one. */
  private game: LiveGame | undefined;
  /** Sequence ids we've already emitted, so polling doesn't double-fire. */
  private readonly seen = new Set<string>();
  /** Monotonic counter for synthesising sequence ids when ESPN omits them. */
  private synthSeq = 0;

  constructor(opts: EspnFeedOptions) {
    this.league = opts.league;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Probe the scoreboard for a live game and lock onto it. Returns true if a
   * game in state 'in' was found. The factory uses this to decide sim-vs-espn.
   */
  async start(): Promise<boolean> {
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    if (!board?.events?.length) return false;

    const live = board.events.find((e) => e.status?.type?.state === 'in');
    if (!live?.id) return false;

    const parsed = parseGameState(live);
    if (!parsed) return false;

    this.game = { eventId: live.id, ...parsed };
    return true;
  }

  state(): GameState {
    // Before start() succeeds we have no real game; return a neutral placeholder
    // so callers never crash. In practice the factory only uses EspnFeed after
    // start() returns true.
    return this.game?.state ?? placeholderState(this.league);
  }

  /**
   * Poll the summary endpoint, diff against what we've already seen, and return
   * the newly-normalized events. Errors are swallowed and reported as "no new
   * events" — a transient blip must never crash the orchestration loop.
   */
  async poll(_now: number = Date.now()): Promise<FeedEvent[]> {
    if (!this.game) return [];

    const summary = await this.getJson<EspnSummary>(SUMMARY(this.league, this.game.eventId));
    if (!summary) return [];

    // Refresh score/clock/status opportunistically from the scoreboard so the
    // app's GameState stays current even between key events. Best-effort only.
    await this.refreshGameState();

    // Collect newly-seen events from BOTH sources, then emit in true chronological
    // order. ESPN returns the full cumulative commentary[] + keyEvents[] every
    // poll, so on the tick where a goal first appears, its structured keyEvent AND
    // the build-up commentary that should OPEN the market can arrive together. We
    // must never surface the goal before that build-up (that would be lookahead),
    // so we sort by clock and break same-clock ties with openers BEFORE resolvers.
    const entries: { ev: FeedEvent; base: number; stopp: number; rank: number }[] = [];
    for (const ke of summary.keyEvents ?? []) {
      const ev = this.normalizeKeyEvent(ke);
      if (ev) entries.push(toEntry(ev, ke.clock?.displayValue));
    }
    for (const c of summary.commentary ?? []) {
      const ev = this.normalizeCommentary(c);
      if (ev) entries.push(toEntry(ev, c.time?.displayValue));
    }
    entries.sort((a, b) => a.base - b.base || a.stopp - b.stopp || a.rank - b.rank);
    return entries.map((e) => e.ev);
  }

  applyGoal(_team: Team): void {
    // For a real feed the scoreline is authoritative on ESPN's side; we pull it
    // in refreshGameState(). We deliberately do NOT locally increment, to avoid
    // double-counting against the upstream score.
  }

  setClock(clock: string): void {
    if (this.game) this.game.state.clock = clock;
  }

  async close(): Promise<void> {
    this.seen.clear();
    this.game = undefined;
  }

  // -------------------------------------------------------------------------
  // Normalization helpers
  // -------------------------------------------------------------------------

  private normalizeKeyEvent(ke: EspnKeyEvent): FeedEvent | undefined {
    const seqId = this.seqId('ke', ke.sequence ?? ke.id);
    if (this.seen.has(seqId)) return undefined;

    const mapped = mapKeyEventType(ke);
    if (!mapped) {
      this.seen.add(seqId); // mark seen so we don't re-evaluate every poll
      return undefined;
    }

    this.seen.add(seqId);
    return {
      gameId: this.game!.eventId,
      ts: Date.now(),
      type: mapped,
      ...(this.teamSide(ke.team?.id) ? { team: this.teamSide(ke.team?.id)! } : {}),
      text: ke.text || ke.type?.text || mapped,
      meta: { sequenceId: seqId, source: 'espn.keyEvent', clock: ke.clock?.displayValue },
    };
  }

  private normalizeCommentary(c: EspnCommentary): FeedEvent | undefined {
    const seqId = this.seqId('cm', c.sequence);
    if (this.seen.has(seqId)) return undefined;

    const text = (c.text ?? '').trim();
    if (!text) return undefined;

    const type = classifyCommentary(text);
    this.seen.add(seqId); // always mark seen; classification is deterministic
    if (!type) return undefined;

    const team = this.teamFromText(text);
    return {
      gameId: this.game!.eventId,
      ts: Date.now(),
      type,
      ...(team ? { team } : {}),
      text,
      meta: { sequenceId: seqId, source: 'espn.commentary', clock: c.time?.displayValue },
    };
  }

  /** Map an ESPN team id to home/away using the game we locked onto. */
  private teamSide(teamId: string | undefined): Team | undefined {
    if (!teamId || !this.game) return undefined;
    if (teamId === this.game.homeTeamId) return 'home';
    if (teamId === this.game.awayTeamId) return 'away';
    return undefined;
  }

  /**
   * Attribute a commentary line to a team by matching its name in the prose
   * ("Free kick, Mexico" → home/away). So markets read "Mexico free kick — GOAL?"
   * not "They free kick — GOAL?", and resolution can team-match correctly.
   */
  private teamFromText(text: string): Team | undefined {
    if (!this.game) return undefined;
    const t = text.toLowerCase();
    const h = this.game.state.home.name.toLowerCase();
    const a = this.game.state.away.name.toLowerCase();
    if (h && t.includes(h)) return 'home';
    if (a && t.includes(a)) return 'away';
    return undefined;
  }

  /** Stable per-event id; synthesise a monotonic one if ESPN omits sequence. */
  private seqId(prefix: string, raw: number | string | undefined): string {
    if (raw !== undefined && raw !== null && `${raw}` !== '') return `espn_${prefix}_${raw}`;
    return `espn_${prefix}_synth_${++this.synthSeq}`;
  }

  /** Re-read the scoreboard to keep score/clock/status fresh. Best-effort. */
  private async refreshGameState(): Promise<void> {
    if (!this.game) return;
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    const ev = board?.events?.find((e) => e.id === this.game!.eventId);
    if (!ev) return;
    const parsed = parseGameState(ev);
    if (parsed) this.game.state = parsed.state;
  }

  /**
   * Fetch + parse JSON with a timeout. Any failure (network, 4xx/5xx, 429,
   * non-JSON body, abort) returns `undefined` rather than throwing — callers
   * treat that as "no data this tick".
   */
  private async getJson<T>(url: string): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (res.status === 429) {
        // Rate limited — back off this tick; the poll interval is our backoff.
        return undefined;
      }
      if (!res.ok) return undefined;
      return (await res.json()) as T;
    } catch {
      // Network error, abort/timeout, or malformed JSON — all non-fatal.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure mapping functions (module-level so they're trivially testable)
// ---------------------------------------------------------------------------

/** Event types that OPEN a market — ordered before same-clock resolvers. */
const OPENER_TYPES: ReadonlySet<FeedEvent['type']> = new Set([
  'penalty',
  'corner',
  'free_kick',
  'attack',
  'dangerous_attack',
]);

/** Parse an ESPN clock ("45'" or "45+2'") into {base, stopp} for chronological sort. */
export function parseClockKey(display: string | undefined): { base: number; stopp: number } {
  if (!display) return { base: 0, stopp: 0 };
  const m = /(\d+)(?:\s*\+\s*(\d+))?/.exec(display);
  return { base: m ? Number.parseInt(m[1]!, 10) : 0, stopp: m && m[2] ? Number.parseInt(m[2], 10) : 0 };
}

/** Wrap a normalized event with its sort keys (clock + opener-before-resolver rank). */
function toEntry(ev: FeedEvent, clock: string | undefined) {
  const { base, stopp } = parseClockKey(clock);
  return { ev, base, stopp, rank: OPENER_TYPES.has(ev.type) ? 0 : 1 };
}

/** Build a GameState + team ids from a scoreboard event. */
export function parseGameState(
  ev: EspnEvent,
): { state: GameState; homeTeamId: string | undefined; awayTeamId: string | undefined } | undefined {
  const comp = ev.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away || !ev.id) return undefined;

  const homeRef = teamRef(home);
  const awayRef = teamRef(away);
  const state: GameState = {
    gameId: ev.id,
    sport: 'soccer',
    league: 'soccer',
    home: homeRef,
    away: awayRef,
    scoreHome: toInt(home.score),
    scoreAway: toInt(away.score),
    clock: ev.status?.displayClock ?? "0'",
    status: mapStatus(ev.status?.type?.state),
  };
  return { state, homeTeamId: home.team?.id, awayTeamId: away.team?.id };
}

function teamRef(c: EspnCompetitor): TeamRef {
  const t = c.team ?? {};
  return {
    id: t.id ?? 'unknown',
    name: t.displayName ?? 'Unknown',
    abbr: t.abbreviation ?? (t.displayName ?? 'UNK').slice(0, 3).toUpperCase(),
    ...(t.color ? { color: `#${t.color}` } : {}),
  };
}

export function mapStatus(state: 'pre' | 'in' | 'post' | undefined): GameState['status'] {
  if (state === 'in') return 'live';
  if (state === 'post') return 'final';
  return 'pre';
}

/**
 * Map a structured ESPN keyEvent to a FeedEventType. Returns undefined for
 * events we don't open or resolve markets on (subs, kickoffs, etc.).
 *
 * We match on the free-text `type.text` (e.g. "Goal", "Yellow Card", "Penalty -
 * Scored") because ESPN's numeric `type.id`s are not stable across leagues.
 */
export function mapKeyEventType(ke: EspnKeyEvent): FeedEventType | undefined {
  // `scoringPlay` is the most reliable goal signal ESPN gives us.
  if (ke.scoringPlay) return 'goal';

  const text = `${ke.type?.text ?? ''} ${ke.text ?? ''}`.toLowerCase();

  if (/\bpenalty\b/.test(text)) {
    if (/(scored|converted|goal)/.test(text)) return 'goal';
    if (/(missed|saved|blocked|wide|over)/.test(text)) return 'miss';
    return 'penalty'; // penalty awarded — the bettable "set moment"
  }
  if (/\bgoal\b/.test(text)) return 'goal';
  if (/(card|sent off|booking|red|yellow)/.test(text)) return 'card';
  if (/corner/.test(text)) return 'corner';
  if (/(free.?kick|foul)/.test(text)) return 'free_kick';
  if (/(saved|blocked|cleared off the line)/.test(text)) return 'miss';
  if (/(shot|header|attempt|effort)/.test(text)) {
    return /(off target|wide|over|missed)/.test(text) ? 'miss' : 'shot';
  }
  return undefined;
}

/**
 * Classify free-text commentary into an attack-type "set moment", or undefined.
 * We are deliberately conservative: goals/misses come from keyEvents only, so
 * prose can only ever OPEN a market, never decide one.
 */
export function classifyCommentary(text: string): FeedEventType | undefined {
  const t = text.toLowerCase();
  // Patterns + ordering (most-dangerous first) live in the central tuning module
  // so capture is tuned in ONE place. Prose can only ever OPEN a market — goals
  // and misses come from keyEvents, never from this.
  for (const { type, re } of COMMENTARY_PATTERNS) {
    if (re.test(t)) return type;
  }
  return undefined;
}

function toInt(s: string | undefined): number {
  const n = Number.parseInt(s ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

function placeholderState(league: string): GameState {
  const unknown: TeamRef = { id: 'home', name: 'Home', abbr: 'HOM' };
  const unknown2: TeamRef = { id: 'away', name: 'Away', abbr: 'AWY' };
  return {
    gameId: 'espn-pending',
    sport: 'soccer',
    league,
    home: unknown,
    away: unknown2,
    scoreHome: 0,
    scoreAway: 0,
    clock: "0'",
    status: 'pre',
  };
}
