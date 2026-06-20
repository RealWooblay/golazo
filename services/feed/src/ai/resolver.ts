/**
 * AI market RESOLVER — decides if a goal (or phase end) settles a locked market.
 *
 * Opening uses rules/AI on the opener; RESOLUTION uses ESPN goal text + recent
 * structured events + AI only when ESPN's own description is ambiguous.
 *
 * Example: FK hits wall → 20s later Brazil score from a through ball.
 *   parseGoalSource → "assisted by" → NO (not a FK goal).
 * If ESPN omits detail → Haiku reads recent event list and decides.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { FeedEvent, GameState, Team } from '@golazo/core';
import { config } from '../config';
import {
  type GoalSourceVerdict,
  maxGoalClockDrift,
  parseGoalSource,
  goalCorroborated,
} from './playPhase';
import { clockMinutes } from './marketTuning';

export type ResolveVerdict = 'YES' | 'NO' | 'VOID' | 'PENDING';

export interface GoalResolveContext {
  marketId: string;
  question: string;
  kind: string;
  team: Team | undefined;
  openClockMin: number | undefined;
  phaseActive: boolean;
  eventsSinceOpen: FeedEvent[];
}

export interface GoalResolver {
  resolveGoal(
    ctx: GoalResolveContext,
    goalEv: FeedEvent,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<ResolveVerdict | null>;
}

const RESOLVE_TOOL: Anthropic.Tool = {
  name: 'emit_resolve_decision',
  description:
    'Decide whether a goal settles the open market YES, NO, or should VOID (timing/ambiguity refund).',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['YES', 'NO', 'VOID'],
        description:
          'YES = goal was scored DIRECTLY FROM the bet moment (e.g. direct FK, header from corner). ' +
          'NO = goal happened but NOT from that moment (recycled possession, assisted open play, later move). ' +
          'VOID = cannot tell fairly / timing fault — refund everyone.',
      },
      reason: { type: 'string', description: 'One sentence justification.' },
    },
    required: ['outcome', 'reason'],
    additionalProperties: false,
  },
};

export class ClaudeGoalResolver implements GoalResolver {
  constructor(private readonly anthropic: Anthropic) {}

  async resolveGoal(
    ctx: GoalResolveContext,
    goalEv: FeedEvent,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<ResolveVerdict | null> {
    const teamName =
      ctx.team === 'home' ? homeName : ctx.team === 'away' ? awayName : 'the attacking side';
    const recent = ctx.eventsSinceOpen
      .slice(-14)
      .map(
        (e) =>
          `- [${e.type}${e.team ? `/${e.team}` : ''} @${String(e.meta?.clock ?? '?')}] ${e.text}`,
      )
      .join('\n');

    const userPrompt =
      `Live soccer. ${homeName} ${game.scoreHome}–${game.scoreAway} ${awayName}, clock ${game.clock}.\n\n` +
      `OPEN MARKET (locked, awaiting outcome):\n` +
      `  Question: "${ctx.question}"\n` +
      `  Kind: ${ctx.kind}\n` +
      `  Team: ${teamName}\n` +
      `  Opened at match clock: ${ctx.openClockMin ?? 'unknown'}\n` +
      `  Phase still active: ${ctx.phaseActive}\n\n` +
      `EVENTS SINCE MARKET OPENED:\n${recent || '(none)'}\n\n` +
      `GOAL EVENT NOW:\n` +
      `  [goal/${goalEv.team ?? '?'} @${String(goalEv.meta?.clock ?? '?')}] ${goalEv.text}\n\n` +
      `Does this goal count as YES for the market question? ` +
      `Be strict: a free-kick market is YES only if the goal came DIRECTLY from that free kick ` +
      `(direct shot/header from the kick). If the ball hit the wall, was cleared, recycled, or the ` +
      `goal came from a later move / assist / through ball, that is NO. ` +
      `If the phase clearly ended earlier (open play resumed) before this goal, NO. ` +
      `VOID only if truly unfair to settle.`;

    const res = await this.anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 200,
      system:
        'You are the GOLAZO settlement resolver. You read structured play-by-play text (not video). ' +
        'Set-piece markets are strict: only direct goals FROM that set piece are YES.',
      tools: [RESOLVE_TOOL],
      tool_choice: { type: 'tool', name: RESOLVE_TOOL.name },
      messages: [{ role: 'user', content: userPrompt }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === RESOLVE_TOOL.name,
    );
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) return null;
    const o = toolUse.input as Record<string, unknown>;
    const outcome = o.outcome;
    if (outcome === 'YES' || outcome === 'NO' || outcome === 'VOID') {
      console.log(`[golazo/feed] resolver_ai outcome=${outcome} reason=${String(o.reason ?? '')}`);
      return outcome;
    }
    return null;
  }
}

export const defaultGoalResolver: GoalResolver | null = config.anthropicApiKey
  ? new ClaudeGoalResolver(new Anthropic({ apiKey: config.anthropicApiKey }))
  : null;

/**
 * Resolve a goal against a locked goal-question market.
 * Rules first (phase + ESPN goal text), AI when ambiguous, VOID when unfair.
 */
export async function resolveGoalForMarket(
  ctx: GoalResolveContext,
  goalEv: FeedEvent,
  game: GameState,
  homeName: string,
  awayName: string,
  resolver: GoalResolver | null = defaultGoalResolver,
  recentCommentary: FeedEvent[] = [],
): Promise<ResolveVerdict> {
  if (!ctx.phaseActive) {
    console.log(`[golazo/feed] resolver_skip phase_inactive market=${ctx.marketId}`);
    return 'PENDING';
  }

  if (ctx.team && goalEv.team && ctx.team !== goalEv.team) {
    return 'PENDING';
  }

  const goalClock = clockMinutes(goalEv);
  if (
    ctx.openClockMin !== undefined &&
    goalClock !== undefined &&
    goalClock - ctx.openClockMin > maxGoalClockDrift(ctx.kind)
  ) {
    console.log(
      `[golazo/feed] resolver_skip clock_drift market=${ctx.marketId} ` +
        `open=${ctx.openClockMin} goal=${goalClock}`,
    );
    return 'PENDING';
  }

  const source: GoalSourceVerdict = parseGoalSource(goalEv.text, ctx.kind);
  if (source === 'yes' || (goalCorroborated(goalEv, recentCommentary) && source !== 'no')) {
    return 'YES';
  }
  if (source === 'no') return 'NO';

  if (resolver) {
    try {
      const ai = await withTimeout(
        resolver.resolveGoal(ctx, goalEv, game, homeName, awayName),
        config.aiResolveTimeoutMs,
      );
      if (ai) return ai;
    } catch (err) {
      console.log(`[golazo/feed] resolver_error ${String(err)}`);
    }
  }

  if (ctx.kind === 'goal_from_open_play') return 'YES';
  return 'NO';
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
