/**
 * QUESTION ENHANCER — the ONLY place AI touches GOLAZO, and it touches ONLY the human
 * question text. It NEVER decides whether/when a market opens, its kind, team, window,
 * odds, or how it resolves — the deterministic engine owns all of that. This exists
 * because the rules pick a market and the templated phrasing is repetitive; AI makes the
 * SAME market read better and stay situation-aware.
 *
 * Hard guarantees (why this can't hurt reliability or real money):
 *   • OFF THE HOT PATH. A slow background timer (refreshMs, ~15s) pre-generates a POOL of
 *     candidate lines. The opener calls `pick()` which is a SYNCHRONOUS in-memory lookup —
 *     opening a market never awaits the model, so the model can never add latency, block,
 *     or reorder a market open.
 *   • FAIL-OPEN. No key, disabled, timeout, error, budget exhausted, or an empty/stale
 *     pool → `pick()` returns the caller's template. The rule-only phrasing is the floor.
 *   • OUTPUT-VALIDATED. Every generated line must name the right team, carry the right
 *     kind keyword, fit a length bound, and contain no stray numbers (blocks hallucinated
 *     scores/clocks) before it can enter the pool. Anything off-spec is dropped.
 *   • HASH-SAFE. Because the line is chosen BEFORE the market opens (pool lookup, not a
 *     post-open mutation), the on-chain question_hash always matches the displayed text.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { GameState, Team } from '@golazo/core';
import type { MomentumRead } from './momentum';
import type { CommentaryBuffer } from './commentaryBuffer';

/** A pooled candidate line + when it was generated (for staleness). */
interface PooledLine {
  line: string;
  bornAt: number;
}

/** Lines older than this are never served — the match situation has moved on. */
const STALE_MS = 90_000;
/** Cap pooled variants per (team,kind) so a long spell rotates without unbounded growth. */
const MAX_PER_KEY = 6;
/** Question length sanity bounds. */
const MIN_LEN = 8;
const MAX_LEN = 90;

/** The kinds we enhance (the high-volume momentum markets). Others keep their template. */
type EnhanceKind = 'shot_in_window' | 'score_in_window';

export interface EnhancerOptions {
  apiKey?: string;
  enabled: boolean;
  model: string;
  timeoutMs: number;
  refreshMs: number;
  /** Output-token ceiling per match — exhaustion fails open to templates. */
  matchTokenBudget: number;
  /** Whole minutes of the score_in_window resolve window (drives the score-line prompt). */
  scoreWindowMins: number;
  commentary: CommentaryBuffer;
  getContext: () => { game: GameState; momentum: MomentumRead };
}

export class QuestionEnhancer {
  private readonly opts: EnhancerOptions;
  private readonly client: Anthropic | undefined;
  private readonly pool = new Map<string, PooledLine[]>();
  private tokensUsed = 0;
  private _lastOk = false;
  private inFlight = false;

  constructor(opts: EnhancerOptions) {
    this.opts = opts;
    // Lazily own the ONLY Anthropic SDK instance, and only when actually enabled+keyed.
    this.client =
      opts.enabled && opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : undefined;
  }

  /** True only when a usable client exists — drives the honest health label. */
  get active(): boolean {
    return this.client !== undefined;
  }

  /** Whether the last refresh produced ≥1 valid line (health/observability). */
  get producing(): boolean {
    return this._lastOk;
  }

  private key(team: Team, kind: EnhanceKind): string {
    return `${team}:${kind}`;
  }

  /**
   * SYNCHRONOUS, hot-path-safe. Return the freshest valid pooled line for (team,kind),
   * else the caller's deterministic template. Consumes the line so a spell rotates
   * through variants rather than repeating one.
   */
  pick(team: Team, kind: string, fallback: string, now: number): string {
    if (!this.active || (kind !== 'shot_in_window' && kind !== 'score_in_window')) {
      return fallback;
    }
    const k = this.key(team, kind);
    const lines = this.pool.get(k);
    if (!lines || lines.length === 0) return fallback;
    // Drop stale, then take the freshest.
    const fresh = lines.filter((l) => now - l.bornAt < STALE_MS);
    this.pool.set(k, fresh);
    const next = fresh.shift();
    return next ? next.line : fallback;
  }

  /** Clear all state on a match switch so a prior fixture's lines never leak across. */
  resetForMatch(): void {
    this.pool.clear();
    this.tokensUsed = 0;
    this._lastOk = false;
  }

  /**
   * SLOW background generator (called on its own timer, never from the open path). One
   * model call per cycle for the CURRENT pressing team's shot+score lines, off the live
   * commentary. Any failure/timeout/budget-stop leaves the pool untouched → fail-open.
   */
  async refresh(now: number): Promise<void> {
    if (!this.client || this.inFlight) return;
    if (this.tokensUsed >= this.opts.matchTokenBudget) return; // budget spent → fail open

    const { game, momentum } = this.opts.getContext();
    const team = momentum.leader;
    if (game.status !== 'live' || !team) return; // only enhance live, only the pressing side
    const name = team === 'home' ? game.home.name : game.away.name;
    if (!name) return;

    const scoreMins = Math.max(1, Math.round(this.opts.scoreWindowMins));
    const commentary = this.opts.commentary.formatForAi(10);

    this.inFlight = true;
    try {
      const res = await this.client.messages.create(
        {
          model: this.opts.model,
          max_tokens: 320,
          system:
            'You rewrite a soccer in-play betting market QUESTION to be punchier and ' +
            'situation-aware from the live commentary. RULES: do NOT change what is asked, ' +
            'the team, or the timeframe; never invent or mention any score, scoreline, ' +
            'minute, or player name; keep each under 80 characters and end with "?". ' +
            'Return ONLY JSON: {"shot":[3 strings],"score":[3 strings]}. The "shot" lines ' +
            'ask whether ' + name + ' gets a SHOT away in this spell. The "score" lines ask ' +
            'whether ' + name + ' SCORES in the next ' + scoreMins + ' minutes.',
          messages: [
            {
              role: 'user',
              content:
                'Pressing team: ' + name + '. Recent commentary:\n' + (commentary || '(quiet)'),
            },
          ],
        },
        { timeout: this.opts.timeoutMs },
      );

      this.tokensUsed += res.usage?.output_tokens ?? 0;
      const text = res.content.find((c) => c.type === 'text');
      if (!text || text.type !== 'text') return;
      const parsed = safeParse(text.text);
      if (!parsed) return;

      const shot = this.accept(parsed.shot, name, 'shot_in_window', scoreMins);
      const score = this.accept(parsed.score, name, 'score_in_window', scoreMins);
      if (shot.length) this.store(this.key(team, 'shot_in_window'), shot, now);
      if (score.length) this.store(this.key(team, 'score_in_window'), score, now);
      this._lastOk = shot.length > 0 || score.length > 0;
    } catch (err) {
      // Fail-open: log and leave the pool as-is. The opener will use templates.
      console.log(
        `[golazo/feed] enhancer_refresh_skip ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private store(key: string, lines: string[], now: number): void {
    const merged = [...lines.map((line) => ({ line, bornAt: now })), ...(this.pool.get(key) ?? [])];
    this.pool.set(key, merged.slice(0, MAX_PER_KEY));
  }

  /** Validate + filter model lines for one kind. Anything off-spec is dropped. */
  private accept(raw: unknown, name: string, kind: EnhanceKind, scoreMins: number): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      const line = v.trim();
      if (validateLine(line, name, kind, scoreMins)) out.push(line);
    }
    return out;
  }
}

/** Parse the model's JSON defensively (it may wrap in prose/fences). */
function safeParse(s: string): { shot?: unknown; score?: unknown } | null {
  try {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A line is admissible iff: length in bounds, names the exact team, carries the kind's
 * keyword, and contains no stray digits EXCEPT the legitimate window minute on a score
 * line (so "score in the next 2 minutes?" is fine but "New Zealand 2, Egypt 0" is not —
 * blocking hallucinated scores/clocks). Exported for tests.
 */
export function validateLine(
  line: string,
  name: string,
  kind: EnhanceKind,
  scoreMins: number,
): boolean {
  if (line.length < MIN_LEN || line.length > MAX_LEN) return false;
  if (!line.includes(name)) return false;
  const kw = kind === 'shot_in_window' ? /SHOT|TEST THE KEEPER/i : /SCORE|GOAL/i;
  if (!kw.test(line)) return false;
  // Strip the one allowed number (the score window minute) then require no other digits —
  // this is what stops the model smuggling in a fabricated scoreline or match clock.
  const allowed = kind === 'score_in_window' ? new RegExp(`\\b${scoreMins}\\b`) : null;
  const stripped = allowed ? line.replace(allowed, '') : line;
  if (/\d/.test(stripped)) return false;
  return true;
}
