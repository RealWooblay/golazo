/**
 * Commentary-driven phase resolution for LOCKED goal-question markets.
 *
 * ESPN often narrates set-pieces richly in commentary ("short pass from the free
 * kick", "cleared", "attempt saved") while structured keyEvents lag or never
 * arrive. Rules classify obvious lines; AI reads the full recent stream when
 * rules are inconclusive.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { FeedEvent, GameState } from '@golazo/core';
import { config } from '../config';
import { clockMinutes } from './marketTuning';
import type { CommentaryBuffer } from './commentaryBuffer';

export type PhaseResolveVerdict = 'YES' | 'NO' | 'PENDING';

const PHASE_TOOL: Anthropic.Tool = {
  name: 'emit_phase_decision',
  description:
    'Decide whether a locked set-piece / chance market has ended (NO), scored YES from that moment, or is still live (PENDING).',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['YES', 'NO', 'PENDING'],
        description:
          'NO = the moment ended without a direct goal from it (kick taken & cleared, shot saved/missed, open play resumed). ' +
          'YES = commentary confirms a goal DIRECTLY from this set-piece (rare — only when explicit). ' +
          'PENDING = still waiting / unclear.',
      },
      reason: { type: 'string' },
    },
    required: ['outcome', 'reason'],
    additionalProperties: false,
  },
};

export interface PhaseResolver {
  resolvePhase(
    ctx: {
      question: string;
      kind: string;
      openerType: string | undefined;
      openClockMin: number | undefined;
      eventsSinceOpen: FeedEvent[];
    },
    buffer: CommentaryBuffer,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<PhaseResolveVerdict | null>;
}

export class ClaudePhaseResolver implements PhaseResolver {
  constructor(private readonly anthropic: Anthropic) {}

  async resolvePhase(
    ctx: {
      question: string;
      kind: string;
      openerType: string | undefined;
      openClockMin: number | undefined;
      eventsSinceOpen: FeedEvent[];
    },
    buffer: CommentaryBuffer,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<PhaseResolveVerdict | null> {
    const recent = buffer.formatForAi(16);
    const since = ctx.eventsSinceOpen
      .slice(-12)
      .map(
        (e) =>
          `- [${e.type}${e.team ? `/${e.team}` : ''} @${String(e.meta?.clock ?? '?')}] ${e.text}`,
      )
      .join('\n');

    const prompt =
      `Live soccer. ${homeName} ${game.scoreHome}–${game.scoreAway} ${awayName}, clock ${game.clock}.\n\n` +
      `LOCKED MARKET awaiting outcome:\n` +
      `  Question: "${ctx.question}"\n` +
      `  Kind: ${ctx.kind}\n` +
      `  Opened at: ${ctx.openClockMin ?? 'unknown'}'\n` +
      `  Opener: ${ctx.openerType ?? 'unknown'}\n\n` +
      `RECENT COMMENTARY STREAM (read carefully — this is the primary signal):\n${recent || '(empty)'}\n\n` +
      `STRUCTURED EVENTS SINCE OPEN:\n${since || '(none)'}\n\n` +
      `Has this moment ENDED without a direct goal from it? ` +
      `Commentary like "short pass from the free kick", "cleared", "wall", "attempt saved", ` +
      `"open play resumes", or a new attack = NO. ` +
      `YES only if commentary explicitly says a goal came DIRECTLY from this free kick/corner/penalty. ` +
      `PENDING only if the set-piece clearly has NOT been taken yet.`;

    const res = await this.anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 180,
      system:
        'GOLAZO phase resolver. You read live commentary text, not video. ' +
        'When commentary shows the set-piece was taken (even a tiny pass) and play moved on → NO. ' +
        'Be decisive — users are waiting.',
      tools: [PHASE_TOOL],
      tool_choice: { type: 'tool', name: PHASE_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === PHASE_TOOL.name,
    );
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) return null;
    const o = toolUse.input as Record<string, unknown>;
    const outcome = o.outcome;
    if (outcome === 'YES' || outcome === 'NO' || outcome === 'PENDING') {
      console.log(
        `[golazo/feed] phase_resolver_ai outcome=${outcome} reason=${String(o.reason ?? '')}`,
      );
      return outcome;
    }
    return null;
  }
}

export const defaultPhaseResolver: PhaseResolver | null = config.anthropicApiKey
  ? new ClaudePhaseResolver(new Anthropic({ apiKey: config.anthropicApiKey }))
  : null;

/** Rules-first: did recent commentary show the set-piece/chance ended? */
export function commentaryEndsSetPiecePhase(
  events: FeedEvent[],
  openerType: FeedEvent['type'] | undefined,
  openClockMin: number | undefined,
): boolean {
  if (
    !openerType ||
    (openerType !== 'free_kick' && openerType !== 'corner' && openerType !== 'penalty')
  ) {
    return false;
  }
  for (const ev of events) {
    const evMin = clockMinutes(ev);
    if (openClockMin !== undefined && evMin !== undefined && evMin < openClockMin - 0.15) {
      continue;
    }
    if (ev.type === 'miss' || ev.type === 'shot' || ev.type === 'play_end') return true;
    if (ev.type === 'attack' || ev.type === 'dangerous_attack') return true;
    if (ev.type === 'calm' && ev.meta?.delay === 'end') return true;
  }
  return false;
}
