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
  requiresTeam,
  type FeedEvent,
  type GameState,
  type MarketTrigger,
  type Team,
} from '@golazo/core';
import { config } from '../config';
import {
  tierOf as tuningTierOf,
  knobFor,
  isStructuredSetPiece,
  isAwardedFreeKick,
  isDefensiveSetPiece,
  isPostShotCommentary,
  isMomentumBuildUp,
  parseGameContext,
  confidenceWindowMs,
} from './marketTuning';
import { seqKey } from './batchJudge';

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
  /** Pre-computed batch decision for this event (from batch judge). */
  batchDecision?: MarketDecision | null;
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
  const baseWindow = Number(process.env.BET_WINDOW_MS_OVERRIDE) || knob.betWindowMs;
  const windowMs = (conf: number) => confidenceWindowMs(baseWindow, conf, game);

  // Deterministic fallback, computed once so every degraded path is a plain return.
  const ruleTrigger = triggerFromEvent(latest, {
    ...(ctx.homeName !== undefined ? { homeName: ctx.homeName } : {}),
    ...(ctx.awayName !== undefined ? { awayName: ctx.awayName } : {}),
  });
  const withWindow = (t: MarketTrigger | null, conf = 0.55): MarketTrigger | null =>
    t ? { ...t, windowMs: windowMs(conf) } : t;

  // Post-shot ESPN lines ("Attempt saved…") must never open — play is over.
  if (isPostShotCommentary(latest.text)) {
    console.log(
      `[golazo/feed] watcher_skip_post_shot type=${latest.type} text="${latest.text.slice(0, 60)}"`,
    );
    return null;
  }

  // Defensive / own-half free kicks are never a goal chance — skip BEFORE any AI
  // cost (a FK in their own keeper's box is not a market).
  if (latest.type === 'free_kick' && isDefensiveSetPiece(latest.text)) {
    console.log(
      `[golazo/feed] watcher_skip_defensive_fk text="${latest.text.slice(0, 60)}"`,
    );
    return null;
  }

  // When the AI gives an explicit "not bettable" verdict we respect it (quality).
  // When the AI is UNAVAILABLE (timeout / error / no key), we don't go dark — a
  // `dangerous_attack` already matched the dangerous-chance commentary pattern, so
  // it's safe to open via rules. Otherwise the product silently produces no markets
  // whenever the model is slow.
  const rulesFallback = (aiUnavailable = false): MarketTrigger | null => {
    // When the model is slow/absent we DON'T go dark — forward-play commentary
    // already matched the attack patterns, so open the "on this play" market via
    // rules. These resolve fast (shot = YES, fizzle = NO), so a few extra are fine.
    if (aiUnavailable && (latest.type === 'dangerous_attack' || latest.type === 'attack')) {
      return withWindow(ruleTrigger, latest.type === 'dangerous_attack' ? 0.6 : 0.45);
    }
    if (latest.type === 'attack' && isMomentumBuildUp(latest.text)) return withWindow(ruleTrigger);
    return null;
  };

  // Awarded FK (keyEvent or "wins a free kick" commentary) + corners/penalties: instant.
  if (knob.tier === 'set_piece' || isStructuredSetPiece(latest) || isAwardedFreeKick(latest)) {
    console.log(
      `[golazo/feed] watcher_open_rules type=${latest.type} source=${String(latest.meta?.source)}`,
    );
    return withWindow(ruleTrigger, 0.9);
  }

  // Batch decision already computed for this candidate.
  if (opts.batchDecision) {
    const d = opts.batchDecision;
    if (!d.bettable || d.confidence < knob.minConfidence) {
      return rulesFallback();
    }
    return decisionToTrigger(d, latest, ruleTrigger, windowMs(d.confidence));
  }

  // FUZZY (commentary FK, open-play): AI judges when a key is configured.
  const judge = opts.judge !== undefined ? opts.judge : defaultJudge;
  if (!judge) {
    return rulesFallback(true);
  }

  try {
    const decision = await withTimeout(
      judge.judge(recentEvents, latest, game, ctx),
      config.aiTimeoutMs,
    );
    if (!decision) {
      console.log(`[golazo/feed] watcher_timeout type=${latest.type} text="${latest.text.slice(0, 60)}"`);
      return rulesFallback(true);
    }
    if (!decision.bettable || decision.confidence < knob.minConfidence) {
      console.log(
        `[golazo/feed] watcher_skip type=${latest.type} bettable=${decision.bettable} ` +
          `conf=${decision.confidence.toFixed(2)} min=${knob.minConfidence} ` +
          `text="${latest.text.slice(0, 60)}"`,
      );
      return rulesFallback();
    }
    console.log(
      `[golazo/feed] watcher_open_ai type=${latest.type} conf=${decision.confidence.toFixed(2)} ` +
        `q="${decision.question.slice(0, 50)}"`,
    );
    return decisionToTrigger(decision, latest, ruleTrigger, windowMs(decision.confidence));
  } catch (err) {
    console.log(`[golazo/feed] watcher_error type=${latest.type} ${String(err)}`);
    return rulesFallback(true);
  }
}

// ---------------------------------------------------------------------------
// Claude judge (the real MarketJudge). Reached only for FUZZY events.
// ---------------------------------------------------------------------------

const DECISION_TOOL: Anthropic.Tool = {
  name: 'emit_market_decision',
  description:
    'Decide if the attacking team is going forward RIGHT NOW such that we can open a fast ' +
    '"will this MOVE produce a shot?" market. We WANT lots of these — bet on the play/possession.',
  input_schema: {
    type: 'object',
    properties: {
      bettable: {
        type: 'boolean',
        description:
          'The market is "Will this MOVE produce a shot (or goal)?" — it resolves YES on a shot/goal ' +
          'and NO if the move fizzles, possession is lost, or a short timer runs out. ' +
          'True whenever a team has the ball and is genuinely GOING FORWARD with intent: building an ' +
          'attack, counter, pressing high, driving through midfield, in the final third, a promising ' +
          'restart in the attacking half. Lean towards TRUE for live forward play — these are meant to be frequent. ' +
          'False only for: the ball in their OWN defensive half / going backwards, play clearly dead with no ' +
          'imminent restart, post-shot lines ("attempt saved/blocked", "remate parado"), or already-decided plays.',
      },
      confidence: {
        type: 'number',
        description:
          '0..1: how live and forward this move is. Final-third attack / clear break = HIGH (>0.7); ' +
          'a team driving forward in midfield or a promising attacking-half possession = MEDIUM (0.4–0.6); ' +
          'tepid own-half or backwards play = LOW (<0.3). The bar to open is LOW — only filter out non-forward play.',
      },
      question: { type: 'string', description: 'Punchy YES/NO question, <60 chars, e.g. "Türkiye on the ball — SHOT this move?". Empty if not bettable.' },
      kind: { type: 'string', description: "Always 'chance_from_play' for open-play moves. Empty if not bettable." },
      trueProb: { type: 'number', description: 'Estimated P(a shot results) 0..1, to seed odds. Never shown. 0 if not bettable.' },
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
      .slice(-8)
      .map((e) => {
        const lang = typeof e.meta?.lang === 'string' ? `[${e.meta.lang}] ` : '';
        return `- ${lang}[${e.type}${e.team ? `/${e.team}` : ''}] ${e.text}`;
      })
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
      `Recent commentary (oldest→newest; [es]/[en] = ESPN language feed):\n${recentText}\n\n` +
      `THE MOMENT (latest): [${latest.type}${latest.team ? `/${latest.team}` : ''}] ${latest.text}\n\n` +
      `Open a fast "will this MOVE produce a SHOT?" market if the attacking team is GOING FORWARD now. ` +
      `Commentary may be Spanish or English — read both. Spanish names zones/fouls earlier ` +
      `("ha recibido una falta en campo contrario" = attacking-half play; "en ataque", "campo contrario" = going forward). ` +
      `Use commentary for LOCATION/DIRECTION: ball in the attacking half / final third / a counter or press = bettable; ` +
      `ball in their OWN defensive half or going backwards is NOT. ` +
      `We WANT frequent markets — lean towards bettable=true for any genuine forward play, not just clear-cut chances. ` +
      `Reject only post-shot lines ("remate parado", "attempt saved"), dead/backwards play, and already-decided plays. ` +
      `Name the ATTACKING team. kind='chance_from_play'. Set confidence by how live/forward the move is.`;

    const res = await this.anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 256,
      system:
        'You are the GOLAZO in-play betting watcher. You read the live commentary stream (not video) and decide if ' +
        'the attacking team is going forward enough to open a fast "will this move produce a shot?" market. ' +
        'These are meant to be FREQUENT — the fun is betting on each possession/play. Open readily on real forward ' +
        'play (attacks, counters, high pressing, final-third possession); the only things to filter out are ' +
        'own-half/backwards play, dead balls with no imminent restart, and already-decided or post-shot moments.',
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
  let kind = decision.kind.trim() || ruleTrigger?.kind;
  // Safety: open-play moments ALWAYS use the fast "on this play" kind, whatever
  // the model labelled it — that's what gives shot=YES / fizzle=NO resolution.
  if (latest.type === 'attack' || latest.type === 'dangerous_attack') kind = 'chance_from_play';
  if (!question || !kind) return ruleTrigger ? { ...ruleTrigger, windowMs } : null;
  // No team → no market: a team-bound question with no side renders as "They …"
  // and can't be resolved by team correlation.
  if (!latest.team && requiresTeam(kind)) return null;
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
