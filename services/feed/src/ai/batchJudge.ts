/**
 * Batch AI judge — one Haiku call per poll tick for all fuzzy candidates.
 * Cheaper and better context than per-line judging.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { FeedEvent, GameState } from '@golazo/core';
import { config } from '../config';
import { knobFor, parseGameContext } from './marketTuning';
import { parseDecision, type MarketDecision } from './watcher';
import type { CommentaryBuffer } from './commentaryBuffer';
import { tierOf } from './watcher';

export interface BatchDecision {
  sequenceId: string;
  decision: MarketDecision;
}

const BATCH_TOOL: Anthropic.Tool = {
  name: 'emit_batch_decisions',
  description: 'Judge each candidate moment. Return one entry per candidate id.',
  input_schema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Candidate sequence id' },
            bettable: { type: 'boolean' },
            confidence: { type: 'number' },
            question: { type: 'string' },
            kind: { type: 'string' },
            trueProb: { type: 'number' },
          },
          required: ['id', 'bettable', 'confidence', 'question', 'kind', 'trueProb'],
        },
      },
    },
    required: ['decisions'],
    additionalProperties: false,
  },
};

export interface BatchJudge {
  judgeBatch(
    candidates: FeedEvent[],
    buffer: CommentaryBuffer,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<Map<string, MarketDecision>>;
}

export class ClaudeBatchJudge implements BatchJudge {
  constructor(private readonly anthropic: Anthropic) {}

  async judgeBatch(
    candidates: FeedEvent[],
    buffer: CommentaryBuffer,
    game: GameState,
    homeName: string,
    awayName: string,
  ): Promise<Map<string, MarketDecision>> {
    const out = new Map<string, MarketDecision>();
    if (!candidates.length) return out;

    const gc = parseGameContext(game);
    const lead =
      gc.scoreMargin === 0
        ? 'level'
        : `${gc.scoreMargin > 0 ? homeName : awayName} lead by ${Math.abs(gc.scoreMargin)}`;

    const candidateBlock = candidates
      .map((ev) => {
        const id = seqKey(ev);
        return `[${id}] [${ev.type}${ev.team ? `/${ev.team}` : ''}] ${ev.text}`;
      })
      .join('\n');

    const prompt =
      `Live soccer. ${homeName} ${game.scoreHome}–${game.scoreAway} ${awayName}, clock ${game.clock}.\n` +
      `State: ${lead}.\n\n` +
      `Recent commentary stream:\n${buffer.formatForAi(14)}\n\n` +
      `CANDIDATES (judge each by id):\n${candidateBlock}\n\n` +
      `For EACH candidate id, decide if the attacking team is GOING FORWARD enough to open a fast ` +
      `"will this MOVE produce a SHOT?" market (kind='chance_from_play'; YES on shot/goal, NO if it fizzles). ` +
      `We WANT frequent markets — lean bettable=true for any genuine forward play (attacks, counters, pressing, ` +
      `final-third possession). Spanish/English — "campo contrario"/"en ataque" = going forward. ` +
      `Reject only post-shot, dead/backwards/own-half play, and already-decided moments. Set confidence by how live/forward it is.`;

    const res = await this.anthropic.messages.create({
      model: config.aiModel,
      max_tokens: 512,
      system:
        'GOLAZO batch watcher. Open fast "shot this move?" markets readily on forward play — these are ' +
        'meant to be FREQUENT (bet on each possession). Only filter out own-half/backwards/dead/decided play. ' +
        'Return a decision for every candidate id.',
      tools: [BATCH_TOOL],
      tool_choice: { type: 'tool', name: BATCH_TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === BATCH_TOOL.name,
    );
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) return out;

    const raw = (toolUse.input as { decisions?: unknown }).decisions;
    if (!Array.isArray(raw)) return out;

    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const parsed = parseDecision({
        bettable: o.bettable,
        confidence: o.confidence,
        question: o.question,
        kind: o.kind,
        trueProb: o.trueProb,
      });
      if (id && parsed) out.set(id, parsed);
    }
    return out;
  }
}

export const defaultBatchJudge: BatchJudge | null = config.anthropicApiKey
  ? new ClaudeBatchJudge(new Anthropic({ apiKey: config.anthropicApiKey }))
  : null;

/** Fuzzy candidates from one poll batch — deduped, capped. */
export function fuzzyCandidates(events: FeedEvent[]): FeedEvent[] {
  const out: FeedEvent[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (tierOf(ev.type) !== 'fuzzy') continue;
    if (!knobFor(ev.type)) continue;
    const k = seqKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
    if (out.length >= 4) break;
  }
  return out;
}

export function seqKey(ev: FeedEvent): string {
  const sid = ev.meta?.sequenceId;
  return typeof sid === 'string' && sid ? sid : `${ev.type}:${ev.ts}:${ev.text.slice(0, 20)}`;
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

export async function runBatchJudge(
  candidates: FeedEvent[],
  buffer: CommentaryBuffer,
  game: GameState,
  homeName: string,
  awayName: string,
  judge: BatchJudge | null = defaultBatchJudge,
): Promise<Map<string, MarketDecision>> {
  if (!judge || !candidates.length) return new Map();
  const result = await withTimeout(
    judge.judgeBatch(candidates, buffer, game, homeName, awayName),
    config.aiTimeoutMs,
  );
  return result ?? new Map();
}
