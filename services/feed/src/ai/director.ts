/**
 * MARKET DIRECTOR — the AI that reads the game's MOOD + CLOCK and proposes WHICH markets to
 * open from a VALIDATED palette it can never break. This is the "intelligent market creation"
 * layer: instead of a fixed rhythm, it picks the markets that fit the moment (a siege → "to
 * SCORE in the next N min?"; an end-to-end spell → "who threatens next?"; never a short play
 * market as the half dies). It tunes WHICH/WHEN/TEAM/WORDING/odds — but it can NOT invent
 * kinds, change how a market resolves, or touch the engine/chain.
 *
 * Hard guarantees (why this can't hurt reliability or real money) — same as the enhancer:
 *   • OFF THE HOT PATH. A slow background timer pre-generates a POOL of validated proposals.
 *     The opener calls `proposeNext()` — a SYNCHRONOUS pool read — so opening a market never
 *     awaits the model, and the model can never add latency, block, or reorder an open.
 *   • FAIL-OPEN. No key, disabled, timeout, error, budget spent, or empty/stale pool → no
 *     proposal; the deterministic rule openers run. The rules are always the floor.
 *   • PALETTE-BOUNDED. Every proposal must pass validateProposal: kind ∈ DIRECTOR_PALETTE,
 *     slot/deadline finite, team present iff team-bound, window/odds/relevance clamped,
 *     question sane (length, names the team, no fabricated scores/clocks). Off-palette →
 *     dropped (caller audits `director_reject`). The AI can break nothing.
 *   • HASH-SAFE. The proposal (incl. question text) is chosen BEFORE the market opens, so the
 *     on-chain question_hash always matches the displayed text.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { GameState, MarketSlot, Team } from '@golazo/core';
import type { MomentumRead } from './momentum';
import type { CommentaryBuffer } from './commentaryBuffer';
import { marketSlot, resolveDeadlineMs, parseGameContext, inWhistleZone } from './marketTuning';

/**
 * The ONLY kinds the director may open — the open-ended play/window/count/versus families.
 * Set-piece / VAR / penalty / period kinds are EVENT-driven (they need a real free kick /
 * review / whistle) and are NOT director-proposable. This allowlist IS the safety boundary.
 */
export const DIRECTOR_PALETTE: ReadonlySet<string> = new Set([
  'shot_in_window',
  'score_in_window',
  'shot_or_corner_in_window',
  'card_in_window',
  'goal_in_window',
  'over_corners',
  'over_shots',
  'next_shot',
  'next_corner',
  'next_goal',
  'next_card',
]);

/** Kinds that REQUIRE a team (a side the market is about). The rest are teamless either-team. */
const TEAM_BOUND: ReadonlySet<string> = new Set([
  'shot_in_window',
  'score_in_window',
  'shot_or_corner_in_window',
  'next_shot',
  'next_corner',
  'next_goal',
  'next_card',
]);

/** A validated, ready-to-open market proposal + when it was generated (for staleness). */
export interface MarketProposal {
  kind: string;
  slot: MarketSlot;
  team?: Team;
  question: string;
  trueProb: number;
  windowMs: number;
  /** 0..1 — the AI's read of how much THIS market fits THIS moment (orders scarce slots). */
  relevance: number;
  bornAt: number;
}

/** Proposals older than this are never served — the match situation has moved on. */
const STALE_MS = 45_000;
/** Question length sanity bounds. */
const MIN_LEN = 8;
const MAX_LEN = 90;
/** Bet-window + odds clamps (the AI tunes within these; it can't set a degenerate market). */
const MIN_WINDOW_MS = 6_000;
const MAX_WINDOW_MS = 20_000;
const MIN_PROB = 0.05;
const MAX_PROB = 0.95;
const MAX_POOL = 6;

export interface DirectorOptions {
  apiKey?: string;
  enabled: boolean;
  model: string;
  timeoutMs: number;
  refreshMs: number;
  /** Output-token ceiling per match — exhaustion fails open to the rule openers. */
  matchTokenBudget: number;
  commentary: CommentaryBuffer;
  getContext: () => {
    game: GameState;
    momentum: MomentumRead;
    /** Seconds since the last goal (any team), or undefined if none yet — drives the
     *  post-goal lull rule (don't propose a goal/score market right after a goal). */
    secondsSinceGoal?: number;
  };
  /** Audit sink for rejected proposals (the validation wall firing). */
  onReject?: (reason: string, raw: unknown) => void;
}

export class MarketDirector {
  private readonly opts: DirectorOptions;
  private readonly client: Anthropic | undefined;
  private pool: MarketProposal[] = [];
  private tokensUsed = 0;
  private _lastOk = false;
  private inFlight = false;

  constructor(opts: DirectorOptions) {
    this.opts = opts;
    this.client = opts.enabled && opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : undefined;
  }

  /** True only when a usable client exists — drives the honest health label. */
  get active(): boolean {
    return this.client !== undefined;
  }

  /** Whether the last refresh produced ≥1 valid proposal (observability). */
  get producing(): boolean {
    return this._lastOk;
  }

  /** Number of fresh proposals queued right now (observability). */
  get queued(): number {
    return this.pool.length;
  }

  /**
   * SYNCHRONOUS, hot-path-safe. Return the freshest, most-relevant valid proposal whose slot
   * the caller hasn't already filled, else undefined → the rule openers run. Consumes it so a
   * spell drips proposals (one per opener opportunity) rather than dumping them at once.
   */
  proposeNext(now: number, slotIsFree: (slot: MarketSlot) => boolean): MarketProposal | undefined {
    if (!this.active) return undefined;
    this.pool = this.pool.filter((p) => now - p.bornAt < STALE_MS);
    // Highest relevance first; only a proposal whose slot is actually open.
    const ordered = [...this.pool].sort((a, b) => b.relevance - a.relevance);
    const pick = ordered.find((p) => slotIsFree(p.slot));
    if (!pick) return undefined;
    this.pool = this.pool.filter((p) => p !== pick);
    return pick;
  }

  /** Clear all state on a match switch so a prior fixture's proposals never leak across. */
  resetForMatch(): void {
    this.pool = [];
    this.tokensUsed = 0;
    this._lastOk = false;
  }

  /**
   * SLOW background generator (own timer, never the open path). One model call per cycle:
   * given the live mood + clock, ask for a small SET of market proposals that fit the moment.
   * Any failure/timeout/budget-stop leaves the pool untouched → fail-open to rules.
   */
  async refresh(now: number): Promise<void> {
    if (!this.client || this.inFlight) return;
    if (this.tokensUsed >= this.opts.matchTokenBudget) return;

    const { game, momentum, secondsSinceGoal } = this.opts.getContext();
    if (game.status !== 'live') return;
    // In stoppage the deterministic whistle guard suppresses these markets anyway — don't
    // spend tokens proposing what the orchestrator will refuse to open.
    if (inWhistleZone(game)) return;

    this.inFlight = true;
    try {
      const res = await this.client.messages.create(
        {
          model: this.opts.model,
          max_tokens: 500,
          system: DIRECTOR_SYSTEM,
          messages: [{ role: 'user', content: this.situationPrompt(game, momentum, secondsSinceGoal) }],
        },
        { timeout: this.opts.timeoutMs },
      );
      this.tokensUsed += res.usage?.output_tokens ?? 0;
      const text = res.content.find((c) => c.type === 'text');
      if (!text || text.type !== 'text') return;
      const raws = safeParseProposals(text.text);
      if (!raws) return;

      const valid: MarketProposal[] = [];
      for (const raw of raws) {
        const p = validateProposal(raw, game, now);
        if (p) valid.push(p);
        else this.opts.onReject?.('invalid_proposal', raw);
      }
      if (valid.length) this.pool = [...valid, ...this.pool].slice(0, MAX_POOL);
      this._lastOk = valid.length > 0;
    } catch (err) {
      console.log(
        `[golazo/feed] director_refresh_skip ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  /** Compact situation brief for the model — phase, clock, score, momentum, recent play. */
  private situationPrompt(game: GameState, momentum: MomentumRead, secondsSinceGoal?: number): string {
    const ctx = parseGameContext(game);
    const leadName =
      momentum.leader === 'home' ? game.home.name : momentum.leader === 'away' ? game.away.name : '(even)';
    const commentary = this.opts.commentary.formatForAi(8) || '(quiet)';
    const justScored =
      secondsSinceGoal !== undefined && secondsSinceGoal < 60
        ? `\nA GOAL was just scored ~${Math.round(secondsSinceGoal)}s ago — the game has restarted from the centre. Do NOT propose a goal_in_window or score_in_window now; prefer a card, an over/under, or who-threatens-next.`
        : '';
    return [
      `Home: ${game.home.name}  Away: ${game.away.name}`,
      `Score: ${game.scoreHome}-${game.scoreAway} (margin ${ctx.scoreMargin}, ${ctx.isClose ? 'close' : 'not close'})`,
      `Clock: ${game.clock}  Period: ${ctx.period}  ~${ctx.minutesLeft} min to the half-end${ctx.isStoppage ? ' (STOPPAGE)' : ''}`,
      `Momentum: ${leadName} pressing (intensity ${momentum.intensity.toFixed(1)})`,
      `Recent commentary:\n${commentary}${justScored}`,
    ].join('\n');
  }
}

const DIRECTOR_SYSTEM = [
  'You are the market DIRECTOR for a live soccer in-play betting board. From the situation,',
  'choose 2-4 markets that fit THIS moment. Return ONLY JSON: an array of',
  '{"kind","team","question","trueProb","windowMs","relevance"}.',
  '',
  'Allowed kinds ONLY (anything else is dropped):',
  '- shot_in_window (team): will TEAM get a shot away this spell?',
  '- score_in_window (team): will TEAM SCORE in the next few minutes? (use for a real siege)',
  '- shot_or_corner_in_window (team): a shot OR corner from TEAM this spell? (broader, higher yes)',
  '- next_shot (team): who threatens NEXT — shot/corner/danger before the other side?',
  '- next_corner (team): who gets the NEXT corner before the other side?',
  '- next_goal (team): who scores NEXT before the other side? (only when end-to-end and open)',
  '- next_card (team): whose player is booked NEXT before the other side?',
  '- card_in_window (no team): a booking in the next few minutes?',
  '- goal_in_window (no team): a goal by EITHER team in the next few minutes?',
  '- over_corners / over_shots (no team): more than the line of corners/shots soon?',
  '',
  'RULES: team kinds MUST set "team" to "home" or "away"; teamless kinds MUST omit it.',
  'The question must NAME the team for team kinds, end with "?", be under 90 chars, and contain',
  'NO score, scoreline, minute, or player name. trueProb in 0.05..0.95 (your honest YES chance);',
  'windowMs is the BET window in 6000..20000; relevance in 0..1 (how well it fits the moment).',
  '',
  'VARIETY IS THE JOB. Across your 2-4 proposals use DIFFERENT kinds — never two of the same',
  'kind, and avoid repeating a kind you would have just proposed. Fit the moment: a siege →',
  'score_in_window for the pressing team; end-to-end → next_shot; a scrappy, niggly game →',
  'next_card or card_in_window; a quiet, even game → a broad over-under or goal_in_window.',
  '',
  'WORDING: write each question like a mate watching live — punchy, specific to THIS moment,',
  'never a generic template. Vary your phrasing every time so the board feels alive and real,',
  'not looped. Pull a detail from the recent commentary when you can (without naming a player).',
].join('\n');

/** Parse the model's JSON array defensively (it may wrap in prose/fences). */
function safeParseProposals(s: string): unknown[] | null {
  try {
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * THE VALIDATION WALL. A raw model object becomes a proposal iff it is fully inside the
 * palette: known kind, correct team-boundedness against a real side, sane question (length,
 * names the team, no fabricated digits), and clamped window/odds/relevance. Anything off-spec
 * returns null and is dropped. Exported for tests. This is what makes the director unable to
 * break resolution or open a degenerate market.
 */
export function validateProposal(raw: unknown, game: GameState, now: number): MarketProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (!DIRECTOR_PALETTE.has(kind)) return null;

  const slot = marketSlot(kind);
  if (!resolveDeadlineMs(kind) || resolveDeadlineMs(kind) <= 0) return null;

  // Team-boundedness must match the kind, and a present team must be a real side.
  const teamBound = TEAM_BOUND.has(kind);
  let team: Team | undefined;
  if (teamBound) {
    if (o.team !== 'home' && o.team !== 'away') return null;
    team = o.team;
  } else if (o.team !== undefined && o.team !== null) {
    return null; // teamless kind must not carry a team
  }
  const teamName = team === 'home' ? game.home.name : team === 'away' ? game.away.name : undefined;

  const question = typeof o.question === 'string' ? o.question.trim() : '';
  if (!validateQuestion(question, teamName)) return null;

  const trueProb = clamp(toNum(o.trueProb, 0.4), MIN_PROB, MAX_PROB);
  const windowMs = clamp(Math.round(toNum(o.windowMs, 10_000)), MIN_WINDOW_MS, MAX_WINDOW_MS);
  const relevance = clamp(toNum(o.relevance, 0.5), 0, 1);

  return { kind, slot, team, question, trueProb, windowMs, relevance, bornAt: now };
}

/** A question is admissible iff: length in bounds, ends with '?', names the team (if team-bound),
 *  and carries NO digits (no fabricated score/clock/minute can slip through). */
function validateQuestion(q: string, teamName: string | undefined): boolean {
  if (q.length < MIN_LEN || q.length > MAX_LEN) return false;
  if (!q.endsWith('?')) return false;
  if (/\d/.test(q)) return false; // block any fabricated number outright
  if (teamName && !q.includes(teamName)) return false;
  return true;
}

function toNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
