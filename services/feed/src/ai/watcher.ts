/**
 * Tiered in-play WATCHER — decides if the latest moment is a bettable opportunity
 * and phrases it, as cheaply as possible.
 *
 * IT READS THE EVENT/COMMENTARY STREAM, NOT VIDEO. Its judgement is only ever as
 * good as the text it's given.
 *
 * COST TIERS (this is the whole point — "constantly watching" must be ~free):
 *   • IGNORE      — not an openable moment (goal/miss/card/calm/…). $0, no work.
 *   • SET-PIECE   — penalty / corner / free-kick AWARDED. Unambiguous, so RULES
 *                   open the market directly. **Never touches the LLM → $0.**
 *   • FUZZY       — open-play build-up ("breaks through, one-on-one!"). The only
 *                   tier that needs judgement, so ONLY this calls the LLM (Haiku),
 *                   and only when a key is configured. No key → rules.
 * On the real Croatia–England match this routes ~46 set-pieces to rules and only
 * ~19 fuzzy lines to the model — fractions of a cent per match.
 *
 * The LLM is injected (`MarketJudge`), so the tiering + fallback are unit-tested
 * deterministically with a fake judge — no API key, no network, in CI.
 *
 * GRACEFUL DEGRADATION: missing key, API error, timeout, or malformed output all
 * fall back to `triggerFromEvent` from @golazo/core. A market still opens; it's
 * just phrased by rules. The engine never knows which path produced the trigger.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  triggerFromEvent,
  type FeedEvent,
  type GameState,
  type MarketTrigger,
  type Team,
} from '@golazo/core';
import { config } from '../config';
import {
  tierOf as tuningTierOf,
  knobFor,
  parseGameContext,
  windowMultiplier,
} from './marketTuning';

/**
 * QUALITY OVER QUANTITY: we do NOT open a market on every event — only when we're
 * CONFIDENT it's a real, dangerous, TIMELY chance. The tiers, betting windows and
 * confidence thresholds all live in ./marketTuning (the single tuning surface):
 *  - SET_PIECE (penalty, corner): inherently a chance → rules open it instantly.
 *  - FUZZY (free_kick, open-play): danger depends on context — a free-kick can be
 *    defensive, an "attack" can fizzle — so the LLM judges it and scores CONFIDENCE;
 *    we open only at/above the per-type minConfidence. No AI key → fuzzy is skipped
 *    (better nothing than a junk market). Open-play IS the core and stays.
 */
export type Tier = 'ignore' | 'set_piece' | 'fuzzy';

/** Which cost tier an event falls into (from the central tuning). Exported for tests. */
export function tierOf(type: FeedEvent['type']): Tier {
  return tuningTierOf(type);
}

export interface AiWatcherContext {
  homeName?: string;
  awayName?: string;
}

/** Validated shape of a judgement (from the LLM or a test fake). */
export interface MarketDecision {
  bettable: boolean;
  question: string;
  kind: string;
  trueProb: number;
  /** 0..1 — how sure this is a REAL, dangerous, timely chance. Gates whether we open. */
  confidence: number;
}

/**
 * The judgement port. The real implementation calls Claude; tests inject a fake.
 * Returns null on "couldn't decide" (caller falls back to rules).
 */
export interface MarketJudge {
  judge(
    recentEvents: FeedEvent[],
    latest: FeedEvent,
    game: GameState,
    ctx: AiWatcherContext,
  ): Promise<MarketDecision | null>;
}

export interface WatcherOptions {
  /** Inject a judge (tests) or null to force rules-only. Defaults to the Claude judge if a key exists. */
  judge?: MarketJudge | null;
}

/**
 * Decide whether to open a market for the LATEST event, given recent context.
 * Tiered: ignore → null; set-piece → rules (no LLM); fuzzy → judge (else rules).
 */
export async function aiTriggerFromEvents(
  recentEvents: FeedEvent[],
  game: GameState,
  ctx: AiWatcherContext = {},
  opts: WatcherOptions = {},
): Promise<MarketTrigger | null> {
  const latest = recentEvents[recentEvents.length - 1];
  if (!latest) return null;

  const knob = knobFor(latest.type);
  if (!knob) return null; // ignore — not an openable moment

  // CONTEXT-AWARE betting window: stretch it in the tense, late, extra-time moments.
  // BET_WINDOW_MS_OVERRIDE (ops/demo knob, 0/unset = off) forces a fixed base
  // window — handy to hold markets open longer for slow demos / manual testing.
  const gameCtx = parseGameContext(game);
  const baseWindow = Number(process.env.BET_WINDOW_MS_OVERRIDE) || knob.betWindowMs;
  const windowMs = Math.round(baseWindow * windowMultiplier(gameCtx));

  // Deterministic fallback, computed once so every degraded path is a plain return.
  const ruleTrigger = triggerFromEvent(latest, {
    ...(ctx.homeName !== undefined ? { homeName: ctx.homeName } : {}),
    ...(ctx.awayName !== undefined ? { awayName: ctx.awayName } : {}),
  });
  const withWindow = (t: MarketTrigger | null): MarketTrigger | null =>
    t ? { ...t, windowMs } : t;

  // SET-PIECE (penalty/corner): inherently an attacking chance → open via rules.
  if (knob.tier === 'set_piece') return withWindow(ruleTrigger);

  // FUZZY (free-kick / open-play): danger depends on context, so the JUDGE decides.
  // With NO judge (no key) we SKIP — better to show nothing than a junk market.
  const judge = opts.judge !== undefined ? opts.judge : defaultJudge;
  if (!judge) return null;

  try {
    const decision = await withTimeout(
      judge.judge(recentEvents, latest, game, ctx),
      config.aiTimeoutMs,
    );
    if (!decision) return null; // timeout / unparseable → no market (don't guess)
    // CONFIDENCE GATE: open only when the judge clears the per-type bar.
    if (!decision.bettable || decision.confidence < knob.minConfidence) return null;
    return decisionToTrigger(decision, latest, ruleTrigger, windowMs);
  } catch {
    return null; // never throw on the hot path; never open on a failed judgement
  }
}

// ---------------------------------------------------------------------------
// Claude judge (the real MarketJudge). Reached only for FUZZY events.
// ---------------------------------------------------------------------------

const DECISION_TOOL: Anthropic.Tool = {
  name: 'emit_market_decision',
  description:
    'Report whether the latest open-play moment is a bettable, not-yet-decided chance, and if so the YES/NO market to open.',
  input_schema: {
    type: 'object',
    properties: {
      bettable: {
        type: 'boolean',
        description:
          'True ONLY if this is a genuine, not-yet-decided GOAL-SCORING chance for the attacking team in a DANGEROUS area ' +
          '(attacking third / in or around the box) RIGHT NOW. False for: defensive or own-half free-kicks, midfield ' +
          'possession, harmless/half-chances, anything already decided, or anything you are unsure about.',
      },
      confidence: {
        type: 'number',
        description:
          '0..1: how sure you are this is a REAL, dangerous, timely scoring chance worth a 6-second market. ' +
          'Be strict — a defensive free-kick or vague "attack" is LOW (<0.4); a clear chance in the box is HIGH (>0.7).',
      },
      question: { type: 'string', description: 'Punchy YES/NO question, <60 chars. Empty if not bettable.' },
      kind: { type: 'string', description: "Machine kind, e.g. 'goal_from_open_play'. Empty if not bettable." },
      trueProb: { type: 'number', description: 'Estimated P(YES) 0..1, to seed odds. Never shown. 0 if not bettable.' },
    },
    required: ['bettable', 'confidence', 'question', 'kind', 'trueProb'],
    additionalProperties: false,
  },
};

export class ClaudeJudge implements MarketJudge {
  constructor(private readonly anthropic: Anthropic) {}

  async judge(
    recentEvents: FeedEvent[],
    latest: FeedEvent,
    game: GameState,
    ctx: AiWatcherContext,
  ): Promise<MarketDecision | null> {
    const home = ctx.homeName ?? game.home.name;
    const away = ctx.awayName ?? game.away.name;
    const recentText = recentEvents
      .slice(-6)
      .map((e) => `- [${e.type}${e.team ? `/${e.team}` : ''}] ${e.text}`)
      .join('\n');

    // Game-state context so the judge can weigh URGENCY (a clear chance in the
    // dying minutes / extra time of a tight game is more bettable than one at 20').
    const gc = parseGameContext(game);
    const lead =
      gc.scoreMargin === 0
        ? 'level'
        : `${gc.scoreMargin > 0 ? home : away} lead by ${Math.abs(gc.scoreMargin)}`;
    const phase = gc.isExtraTime
      ? 'EXTRA TIME'
      : gc.isStoppage
        ? `${gc.period} stoppage time`
        : `${gc.period}, ~${gc.minutesLeft} min left in the half`;

    const userPrompt =
      `Live soccer. ${home} ${game.scoreHome}–${game.scoreAway} ${away}, clock ${game.clock}.\n` +
      `Game state: ${phase}; ${lead}.\n` +
      `Recent commentary (oldest→newest):\n${recentText}\n\n` +
      `THE MOMENT (latest): [${latest.type}${latest.team ? `/${latest.team}` : ''}] ${latest.text}\n\n` +
      `Decide if THIS is a genuine GOAL chance worth a short "will it be a goal?" market. ` +
      `Use the commentary for LOCATION/DANGER: a free-kick or attack in the attacking third / in the box = bettable; ` +
      `a free-kick in their OWN half or near their OWN goal, or midfield possession, is NOT (it won't be a goal). ` +
      `Weigh URGENCY: in the dying minutes or extra time of a close game, a real chance is more bettable. ` +
      `Name the ATTACKING team. Be strict and set confidence accordingly — when unsure, bettable=false.`;

    const res = await this.anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 256,
      system:
        'You are the GOLAZO in-play betting watcher. You read the live commentary stream (not video) and decide if ' +
        'the latest moment is a REAL, dangerous, timely goal chance worth a market. QUALITY OVER QUANTITY: most ' +
        'moments are NOT bettable. Reject defensive/own-half set-pieces, midfield play, half-chances, and anything ' +
        'already decided or ambiguous. Better to open nothing than a junk market.',
      tools: [DECISION_TOOL],
      tool_choice: { type: 'tool', name: DECISION_TOOL.name },
      messages: [{ role: 'user', content: userPrompt }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === DECISION_TOOL.name,
    );
    return toolUse ? parseDecision(toolUse.input) : null;
  }
}

/** The process-wide default judge: Claude if a key is configured, else null (rules-only). */
export const defaultJudge: MarketJudge | null = config.anthropicApiKey
  ? new ClaudeJudge(new Anthropic({ apiKey: config.anthropicApiKey }))
  : null;

// ---------------------------------------------------------------------------
// Pure helpers (exported where useful for tests)
// ---------------------------------------------------------------------------

/** Validate untrusted judgement input: wrong types/NaN/missing → null. */
export function parseDecision(input: unknown): MarketDecision | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.bettable !== 'boolean') return null;
  if (typeof o.question !== 'string') return null;
  if (typeof o.kind !== 'string') return null;
  if (typeof o.trueProb !== 'number' || !Number.isFinite(o.trueProb)) return null;
  // confidence is optional-but-validated: a missing/garbage value is treated as 0
  // (i.e. not confident → won't open), never as "sure".
  const confidence =
    typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? clamp(o.confidence, 0, 1)
      : 0;
  // Sanitize the model's free text before it ever reaches the UI: strip control
  // chars / newlines and bound the length so a malformed-but-typed string can't
  // injection-style break the market card.
  return {
    bettable: o.bettable,
    question: sanitizeText(o.question, 80),
    kind: sanitizeText(o.kind, 40),
    trueProb: o.trueProb,
    confidence,
  };
}

/** Collapse whitespace, strip control characters, and clamp to `max` chars. */
function sanitizeText(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // strip ASCII control chars / newlines
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Turn a validated decision into a MarketTrigger (or null if vetoed/too thin).
 * `windowMs` is the context-aware betting window computed by the caller.
 */
export function decisionToTrigger(
  decision: MarketDecision,
  latest: FeedEvent,
  ruleTrigger: MarketTrigger | null,
  windowMs: number,
): MarketTrigger | null {
  if (!decision.bettable) return null;
  const question = decision.question.trim() || ruleTrigger?.question;
  const kind = decision.kind.trim() || ruleTrigger?.kind;
  if (!question || !kind) return ruleTrigger ? { ...ruleTrigger, windowMs } : null;
  return {
    gameId: latest.gameId,
    question,
    kind,
    ...(latest.team ? { team: latest.team } : {}),
    windowMs,
    trueProb: clamp(decision.trueProb, 0.03, 0.97),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// Keep `Team` import used (re-exported convenience for callers/tests).
export type { Team };
