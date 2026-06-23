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
 *   These are the "set moments" the watcher opens a market on.
 *   Commentary that shows a set-piece was TAKEN (saved, cleared, short pass)
 *   is also emitted as resolver events (`miss`, `play_end`) to settle locked markets.
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
import { COMMENTARY_PATTERNS, classifyResolverCommentary, isPostShotCommentary, isPreShotBuildUp } from '../ai/marketTuning';

/**
 * ±1-day window (UTC) so the scoreboard reliably includes the IN-PROGRESS match.
 * ESPN's default board (no `dates`) drops live games — it returns the day's
 * FINISHED matches but omits the in-progress one — so we MUST pass an explicit
 * date range or the feed never locks onto the live game.
 */
function espnDateWindow(): string {
  const ymd = (ms: number) =>
    new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  const now = Date.now();
  return `${ymd(now - 86_400_000)}-${ymd(now + 86_400_000)}`;
}
const SCOREBOARD = (league: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${espnDateWindow()}`;
const SUMMARY = (league: string, eventId: string, lang?: string) => {
  const base = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(eventId)}&region=us`;
  return lang ? `${base}&lang=${lang}` : base;
};

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
  type?: {
    state?: 'pre' | 'in' | 'post';
    completed?: boolean;
    name?: string;
    shortDetail?: string;
    detail?: string;
    description?: string;
  };
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
  /** Structured actors — participants[0].athlete is the scorer (goal) / shooter (shot). */
  participants?: Array<{ athlete?: { id?: string | number; displayName?: string } }>;
  scoringPlay?: boolean;
  /** ISO wall-clock when ESPN received the play — used for timing, not keywords. */
  wallclock?: string;
}
export interface EspnSummary {
  commentary?: EspnCommentary[];
  keyEvents?: EspnKeyEvent[];
}

/** The primary actor of a keyEvent from ESPN's structured participants:
 *  participants[0].athlete is the scorer on a goal / the shooter on a shot. Used to
 *  power per-player form + resolve "will <player> score?" markets by athlete id. */
function playerOf(ke: EspnKeyEvent): { id: string; name: string } | undefined {
  const a = ke.participants?.[0]?.athlete;
  if (!a?.id || !a.displayName) return undefined;
  return { id: String(a.id), name: a.displayName };
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
  /** Commentary language: dual = EN keyEvents + ES+EN commentary merge. */
  commentaryLang?: 'en' | 'es' | 'dual';
  /** Override for tests; defaults to global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
  /** Tests: emit first-poll backlog. Production: prime `seen` and skip history replay. */
  replayHistory?: boolean;
  /** Manual override: pin the feed to this exact ESPN event id (ignore auto-pick + never
   *  auto-rotate away). Used to force a specific match for testing / concurrent games. */
  forceEventId?: string;
}

export class EspnFeed implements FeedSource {
  readonly kind = 'espn' as const;
  private readonly league: string;
  private readonly commentaryLang: 'en' | 'es' | 'dual';
  private readonly fetchImpl: typeof fetch;

  /** The game we're tracking, once `start()` finds a live one. */
  private game: LiveGame | undefined;
  /** Sequence ids we've already emitted, so polling doesn't double-fire. */
  private readonly seen = new Set<string>();
  /** Bettable-moment keys (type+team+clock) — dedupes commentary/keyEvent twins. */
  private readonly momentsSeen = new Set<string>();
  /** Monotonic counter for synthesising sequence ids when ESPN omits them. */
  private synthSeq = 0;
  /** First poll primes `seen` without replaying the full match history. */
  private primed = false;
  private readonly replayHistory: boolean;
  /** When set, the feed is pinned to this event id (manual override). */
  private readonly forceEventId: string | undefined;

  constructor(opts: EspnFeedOptions) {
    this.league = opts.league;
    this.commentaryLang = opts.commentaryLang ?? 'en';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.replayHistory = opts.replayHistory ?? false;
    this.forceEventId = opts.forceEventId;
  }

  /**
   * Probe the scoreboard for a live game and lock onto it. Returns true if a
   * game in state 'in' was found. The factory uses this to decide sim-vs-espn.
   */
  async start(): Promise<boolean> {
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    if (!board?.events?.length) return false;

    // Pinned (manual override) → lock onto that exact event in any state; otherwise the
    // first live ('in') game on the board.
    const live = this.forceEventId
      ? board.events.find((e) => e.id === this.forceEventId)
      : board.events.find((e) => e.status?.type?.state === 'in');
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

    const summary = await this.fetchSummary();
    if (!summary) return [];

    // First poll after attach: ingest ESPN's cumulative backlog into `seen` only.
    // Replaying 50+ minutes of chances would all be stale and blocks live openers.
    if (!this.primed && !this.replayHistory) {
      for (const ke of summary.keyEvents ?? []) this.normalizeKeyEvent(ke);
      for (const { c, lang } of summary.commentary ?? []) this.normalizeCommentary(c, lang);
      this.primed = true;
      await this.refreshGameState();
      return [];
    }

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
    for (const { c, lang } of summary.commentary ?? []) {
      const ev = this.normalizeCommentary(c, lang);
      if (ev) entries.push(toEntry(ev, c.time?.displayValue));
    }
    entries.sort((a, b) => a.base - b.base || a.stopp - b.stopp || a.rank - b.rank);

    // Dedupe: ESPN publishes the same corner/penalty as commentary AND keyEvent
    // (different sequence ids). Prefer the structured keyEvent in each batch.
    const batchKeMoments = new Set<string>();
    for (const { ev } of entries) {
      if (ev.meta?.source === 'espn.keyEvent') {
        const mk = momentKey(ev);
        if (mk) batchKeMoments.add(mk);
      }
    }
    const out: FeedEvent[] = [];
    for (const { ev } of entries) {
      const mk = momentKey(ev);
      if (mk) {
        if (this.momentsSeen.has(mk)) continue;
        if (ev.meta?.source === 'espn.commentary' && batchKeMoments.has(mk)) continue;
        this.momentsSeen.add(mk);
      }
      out.push(ev);
    }
    return out;
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
    this.momentsSeen.clear();
    this.primed = false;
    this.game = undefined;
  }

  /** The ESPN event id we're tracking (undefined before start). */
  currentEventId(): string | undefined {
    return this.game?.eventId;
  }

  /**
   * True when this match is over and we should look for the next live game.
   * Status is refreshed on every poll via the scoreboard.
   */
  /** Consecutive polls the CURRENT match has reported final — debounces ESPN's
   *  flickery 'post' blips so one blip can't trigger a spurious match-switch that
   *  VOIDs every live market (the "my real shot just voided" bug). */
  private finalPolls = 0;

  shouldRotate(): boolean {
    if (this.forceEventId) return false; // pinned to one match — never auto-rotate away
    return this.finalPolls >= 3;
  }

  /**
   * Switch to the next live ESPN game on the scoreboard. Clears per-match dedupe
   * caches so the new fixture starts fresh. Returns false if nothing else is live.
   */
  async rotateToNextLive(): Promise<boolean> {
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    const currentId = this.game?.eventId;
    const live = (board?.events ?? []).filter((e) => e.status?.type?.state === 'in' && e.id);

    // Only ever rotate to a DIFFERENT live event. Never re-pick the current id (a
    // flicker), which would needlessly void + reopen every market.
    const pick = live.find((e) => e.id !== currentId);
    if (!pick?.id) return false;

    const parsed = parseGameState(pick);
    if (!parsed) return false;

    this.seen.clear();
    this.momentsSeen.clear();
    this.synthSeq = 0;
    this.finalPolls = 0;
    this.game = { eventId: pick.id, ...parsed };
    return true;
  }

  // -------------------------------------------------------------------------
  // Normalization helpers
  // -------------------------------------------------------------------------

  private normalizeKeyEvent(ke: EspnKeyEvent): FeedEvent | undefined {
    const seqId = this.seqId('ke', ke.sequence ?? ke.id);
    if (this.seen.has(seqId)) return undefined;

    const mapped = mapKeyEventType(ke);
    const typeText = (ke.type?.text ?? '').trim();

    // ESPN structured stoppage markers (drinks break, injury delay, etc.)
    if (/^(start delay|inicio retrasado)$/i.test(typeText)) {
      this.seen.add(seqId);
      return {
        gameId: this.game!.eventId,
        ts: Date.now(),
        type: 'calm',
        text: ke.text || 'Stoppage in play',
        meta: {
          sequenceId: seqId,
          source: 'espn.keyEvent',
          clock: ke.clock?.displayValue,
          delay: 'start',
          ...(ke.wallclock ? { wallclock: ke.wallclock } : {}),
        },
      };
    }
    if (/^(end delay|fin del retraso)$/i.test(typeText)) {
      this.seen.add(seqId);
      return {
        gameId: this.game!.eventId,
        ts: Date.now(),
        type: 'calm',
        text: ke.text || 'Play resumes',
        meta: {
          sequenceId: seqId,
          source: 'espn.keyEvent',
          clock: ke.clock?.displayValue,
          delay: 'end',
          ...(ke.wallclock ? { wallclock: ke.wallclock } : {}),
        },
      };
    }

    if (!mapped) {
      this.seen.add(seqId); // mark seen so we don't re-evaluate every poll
      return undefined;
    }

    let team = this.teamSide(ke.team?.id);
    if (!team && (mapped === 'goal' || mapped === 'miss')) {
      team = this.teamFromText(ke.text || ke.type?.text || '');
    }

    this.seen.add(seqId);
    const player = playerOf(ke);
    return {
      gameId: this.game!.eventId,
      ts: Date.now(),
      type: mapped,
      ...(team ? { team } : {}),
      text: ke.text || ke.type?.text || mapped,
      meta: {
        sequenceId: seqId,
        source: 'espn.keyEvent',
        clock: ke.clock?.displayValue,
        ...(ke.wallclock ? { wallclock: ke.wallclock } : {}),
        ...(player ? { player } : {}),
      },
    };
  }

  private normalizeCommentary(c: EspnCommentary, lang: 'en' | 'es' = 'en'): FeedEvent | undefined {
    const seqId = this.seqId('cm', c.sequence, lang);
    if (this.seen.has(seqId)) return undefined;

    const text = (c.text ?? '').trim();
    if (!text) return undefined;

    let type = classifyCommentary(text);
    if (!type) type = classifyResolverCommentary(text);
    if (!type && isAiCommentaryProbe(text)) type = 'attack';
    this.seen.add(seqId); // always mark seen; classification is deterministic
    if (!type) return undefined;

    const awarded = parseAwardedTeamFromCommentary(
      text,
      this.game!.state.home.name,
      this.game!.state.away.name,
      this.game!.state.home.abbr,
      this.game!.state.away.abbr,
    );
    const team = awarded ?? this.teamFromText(text);
    return {
      gameId: this.game!.eventId,
      ts: Date.now(),
      type,
      ...(team ? { team } : {}),
      text,
      meta: {
        sequenceId: seqId,
        source: 'espn.commentary',
        clock: c.time?.displayValue,
        lang,
      },
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
   * Fallback team attribution for open-play lines that name a side in prose.
   * Set-pieces should use parseAwardedTeamFromCommentary first.
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
  private seqId(prefix: string, raw: number | string | undefined, lang?: string): string {
    const langTag = lang ? `${lang}_` : '';
    if (raw !== undefined && raw !== null && `${raw}` !== '') return `espn_${prefix}_${langTag}${raw}`;
    return `espn_${prefix}_${langTag}synth_${++this.synthSeq}`;
  }

  /**
   * Fetch summary payload. `dual` uses EN keyEvents (stable type labels) and merges
   * ES+EN commentary — Spanish FIFA feeds are denser on build-up and fouls.
   */
  private async fetchSummary(): Promise<
    { keyEvents: EspnKeyEvent[]; commentary: { c: EspnCommentary; lang: 'en' | 'es' }[] } | undefined
  > {
    const eventId = this.game!.eventId;
    if (this.commentaryLang === 'dual') {
      const [enSum, esSum] = await Promise.all([
        this.getJson<EspnSummary>(SUMMARY(this.league, eventId, 'en')),
        this.getJson<EspnSummary>(SUMMARY(this.league, eventId, 'es')),
      ]);
      if (!enSum && !esSum) return undefined;
      return {
        keyEvents: enSum?.keyEvents ?? esSum?.keyEvents ?? [],
        commentary: mergeCommentary(enSum?.commentary, esSum?.commentary),
      };
    }
    const lang = this.commentaryLang;
    const sum = await this.getJson<EspnSummary>(SUMMARY(this.league, eventId, lang));
    if (!sum) return undefined;
    return {
      keyEvents: sum.keyEvents ?? [],
      commentary: (sum.commentary ?? []).map((c) => ({ c, lang })),
    };
  }

  /** Re-read the scoreboard to keep score/clock/status fresh. Best-effort. */
  private async refreshGameState(): Promise<void> {
    if (!this.game) return;
    const board = await this.getJson<EspnScoreboard>(SCOREBOARD(this.league));
    const ev = board?.events?.find((e) => e.id === this.game!.eventId);
    if (!ev) return;
    const parsed = parseGameState(ev);
    if (parsed) {
      this.game.state = parsed.state;
      // Count consecutive 'final' polls so shouldRotate() debounces ESPN blips.
      if (parsed.state.status === 'final') this.finalPolls += 1;
      else this.finalPolls = 0;
    }
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
  'var_check',
]);

/** Parse an ESPN clock ("45'" or "45+2'") into {base, stopp} for chronological sort. */
export function parseClockKey(display: string | undefined): { base: number; stopp: number } {
  if (!display) return { base: 0, stopp: 0 };
  const m = /(\d+)\s*'?\s*(?:\+\s*(\d+))?/.exec(display);
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
    status: mapStatus(ev.status),
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

export function mapStatus(status: EspnStatus | undefined): GameState['status'] {
  const state = status?.type?.state;
  const text = [
    status?.displayClock,
    status?.type?.name,
    status?.type?.shortDetail,
    status?.type?.detail,
    status?.type?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (state === 'post') return 'final';
  if (/\b(half[- ]?time|halftime|medio tiempo|descanso|ht)\b/.test(text)) return 'halftime';
  if (state === 'in') return 'live';
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
  if (/\b(half[- ]?time|halftime|medio tiempo|descanso)\b/.test(text)) return 'halftime';

  if (/\b(penalty|penalti)\b/.test(text)) {
    if (/(scored|converted|goal|gol|anotad)/.test(text)) return 'goal';
    if (/(missed|saved|blocked|wide|over|fallad|parad|bloquead)/.test(text)) return 'miss';
    return 'penalty'; // penalty awarded — the bettable "set moment"
  }
  if (/\b(goal|gol)\b/.test(text)) return 'goal';
  if (/(red card|sent off|second yellow|tarjeta roja|expulsado|segunda amarilla)/.test(text)) {
    return 'red_card';
  }
  if (/(yellow card|booking|caution|tarjeta amarilla|amonestaci[oó]n)/.test(text)) {
    return 'yellow_card';
  }
  if (/(card|sent off)/.test(text)) return 'yellow_card';
  // Corner ONLY on structured ESPN corner events — never "corner flag" / "corner of the box".
  const typeText = (ke.type?.text ?? '').trim();
  const bodyText = (ke.text ?? '').trim();
  if (/^(corner|esquina)$/i.test(typeText) || /^(corner|esquina),\s/i.test(bodyText)) {
    return 'corner';
  }
  if (/(free.?kick|foul|falta|tiro libre)/.test(text)) return 'free_kick';
  if (/(saved|blocked|cleared off the line|parad|bloquead)/.test(text)) return 'miss';
  if (/(shot|header|attempt|effort|remate|disparo|cabezazo)/.test(text)) {
    if (/(off target|wide|over|missed|fallad|fuera)/.test(text)) return 'miss';
    return 'shot';
  }
  return undefined;
}

/**
 * Classify free-text commentary into an attack-type "set moment", or undefined.
 * Resolver lines (post-shot, set-piece taken/cleared) return miss/play_end for settlement.
 * Goals still come from keyEvents only — prose never invents a goal.
 */
export function classifyCommentary(text: string): FeedEventType | undefined {
  const t = text.trim().toLowerCase();
  if (isPostShotCommentary(text)) return undefined;
  // Play already stopped — never open on offside calls.
  if (/\b(fuera de juego|offside)\b/.test(t)) return undefined;
  // Resolvers — prose that settles a VAR *penalty* market NO (never opens). Must be
  // PENALTY-specific: a card-related VAR decision ("VAR Decision: No card change")
  // must NOT land here — it routes to var_check below and opens a RED-card market.
  if (
    /\b(no penalty|penalty (?:overturned|cancelled|rescinded|denied)|not a penalty|var[^.]*\bno penalty\b)\b/i.test(
      t,
    )
  ) {
    return 'var_penalty_denied';
  }
  // Awarded set-piece later invalidated by VAR / correction. The orchestrator
  // maps this to VOID for the affected corner/free-kick/penalty-scored market,
  // while a VAR "penalty awarded?" review still maps it to NO.
  if (
    /\b(no corner|not a corner|corner (?:overturned|cancelled|rescinded)|var[^.]*corner[^.]*(?:overturned|cancelled|rescinded)|goal kick after (?:a )?var)\b/i.test(
      t,
    )
  ) {
    return 'var_penalty_denied';
  }
  if (
    /\b(no free[- ]?kick|not a free[- ]?kick|free[- ]?kick (?:overturned|cancelled|rescinded))\b/i.test(
      t,
    )
  ) {
    return 'var_penalty_denied';
  }
  for (const { type, re } of COMMENTARY_PATTERNS) {
    if (re.test(t)) return type;
  }
  if (isPreShotBuildUp(text)) return 'attack';
  return undefined;
}

/**
 * Lines that don't match a pattern but describe live attacking play — route to
 * the AI watcher (fuzzy tier) instead of dropping them.
 */
export function isAiCommentaryProbe(text: string): boolean {
  if (isPostShotCommentary(text)) return false;
  const t = text.trim().toLowerCase();
  if (
    /\b(fuera de juego|offside|sustituci[oó]n|entra al campo|lesi[oó]n|hidrataci[oó]n|saque de (banda|esquina|meta)|tiro de meta|medio tiempo|segunda parte)\b/.test(
      t,
    )
  ) {
    return false;
  }
  return /\([^)]+\)/.test(text) && /\b(pase|centro|regate|asistencia|presi[oó]n|ataque)\b/.test(t);
}

/** Merge ES (primary) + EN (supplement) commentary for richer AI context. */
export function mergeCommentary(
  en: EspnCommentary[] | undefined,
  es: EspnCommentary[] | undefined,
): { c: EspnCommentary; lang: 'en' | 'es' }[] {
  const out: { c: EspnCommentary; lang: 'en' | 'es' }[] = [];
  for (const c of es ?? []) out.push({ c, lang: 'es' });
  const esNorm = new Set((es ?? []).map((c) => (c.text ?? '').trim().toLowerCase()));
  for (const c of en ?? []) {
    const norm = (c.text ?? '').trim().toLowerCase();
    if (norm && !esNorm.has(norm)) out.push({ c, lang: 'en' });
  }
  return out;
}

/**
 * Parse which team is AWARDED a set-piece from ESPN's canonical commentary lines.
 * "Corner, Scotland. Conceded by X" → Scotland (NOT Morocco from "Conceded by").
 * "Brahim Díaz (Morocco) wins a free kick…" → Morocco via the parenthetical.
 */
export function parseAwardedTeamFromCommentary(
  text: string,
  homeName: string,
  awayName: string,
  homeAbbr?: string,
  awayAbbr?: string,
): Team | undefined {
  const raw = text.trim();
  let m = /^corner,\s*([^.]+)/i.exec(raw);
  if (m) return matchTeamFragment(m[1]!, homeName, awayName, homeAbbr, awayAbbr);
  m = /^(?:saque|tiro)\s+de\s+esquina[,\s-]+(?:para\s+|de\s+)?([^.]+)/i.exec(raw);
  if (m) return matchTeamFragment(m[1]!, homeName, awayName, homeAbbr, awayAbbr);
  m = /^penalty(?:\s+awarded)?(?:\s+to)?\s+([^.!]+)/i.exec(raw);
  if (m) return matchTeamFragment(m[1]!, homeName, awayName, homeAbbr, awayAbbr);
  m = /\(([^)]+)\)\s+wins a free kick/i.exec(raw);
  if (m) return matchTeamFragment(m[1]!, homeName, awayName, homeAbbr, awayAbbr);
  m = /\(([^)]+)\)\s+ha recibido una falta/i.exec(raw);
  if (m) return matchTeamFragment(m[1]!, homeName, awayName, homeAbbr, awayAbbr);
  return undefined;
}

function matchTeamFragment(
  fragment: string,
  homeName: string,
  awayName: string,
  homeAbbr?: string,
  awayAbbr?: string,
): Team | undefined {
  const f = fragment.trim().toLowerCase();
  const h = homeName.trim().toLowerCase();
  const a = awayName.trim().toLowerCase();
  if (!f || !h || !a) return undefined;
  // Prefer exact / prefix match so "Scotland" wins over a substring false-positive.
  if (f === h || f.startsWith(`${h} `) || f.startsWith(`${h}.`)) return 'home';
  if (f === a || f.startsWith(`${a} `) || f.startsWith(`${a}.`)) return 'away';
  if (homeAbbr && f === homeAbbr.toLowerCase()) return 'home';
  if (awayAbbr && f === awayAbbr.toLowerCase()) return 'away';
  // ESPN Spanish uses localized names (Brasil/Brazil, Haití/Haiti).
  if (namePrefixOverlap(f, h)) return 'home';
  if (namePrefixOverlap(f, a)) return 'away';
  return undefined;
}

function namePrefixOverlap(a: string, b: string): boolean {
  const n = Math.min(3, a.length, b.length);
  return n >= 3 && a.slice(0, n) === b.slice(0, n);
}

/** Stable key for one real-world bettable moment (dedupes commentary + keyEvent twins). */
export function momentKey(ev: FeedEvent): string | undefined {
  if (!OPENER_TYPES.has(ev.type)) return undefined;
  const clock = typeof ev.meta?.clock === 'string' ? ev.meta.clock : '';
  const { base, stopp } = parseClockKey(clock);
  const isSetPiece = ev.type === 'free_kick' || ev.type === 'corner' || ev.type === 'penalty';
  // The discriminator that keeps DISTINCT moments distinct while still folding a
  // genuine re-stamp of the SAME moment together:
  //   • With a real match-clock: bucket by minute (set-pieces) or minute+stoppage,
  //     so ESPN's 4' vs 4+1' re-stamp of one FK dedupes to a single market.
  //   • WITHOUT a clock (commentary-only / replay): minute would be 0 for EVERY
  //     event and collapse the whole game into one key per team — which is exactly
  //     why a 12-corner half produced a single market. Fall back to a short text
  //     fingerprint so each real corner/FK opens its own market.
  let disc: string;
  if (base > 0) {
    disc = isSetPiece ? `${base}` : `${base}+${stopp}`;
  } else {
    disc = `t${momentTextFingerprint(ev.text)}`;
  }
  return `${ev.type}:${ev.team ?? '?'}:${disc}`;
}

/** Stable, compact fingerprint of a commentary line — distinct lines → distinct keys. */
function momentTextFingerprint(text: string): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32);
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
