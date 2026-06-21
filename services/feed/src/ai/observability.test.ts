import { describe, it, expect } from 'vitest';
import { CommentaryBuffer } from './commentaryBuffer';
import { AuditLog } from '../observability/auditLog';
import { FeedMetrics } from '../observability/metrics';
import { LagMeter } from '../observability/lagMeter';
import type { GameState } from '@golazo/core';

const game: GameState = {
  gameId: 'g1',
  sport: 'soccer',
  league: 'fifa.world',
  home: { id: 'h', name: 'Brazil', abbr: 'BRA' },
  away: { id: 'a', name: 'Haiti', abbr: 'HAI' },
  scoreHome: 0,
  scoreAway: 0,
  clock: "23'",
  status: 'live',
};

describe('CommentaryBuffer', () => {
  it('keeps commentary and fuzzy events', () => {
    const buf = new CommentaryBuffer();
    buf.push({
      gameId: 'g1',
      ts: 1,
      type: 'attack',
      text: 'Brazil surging forward.',
      meta: { source: 'espn.commentary', lang: 'es' },
    });
    expect(buf.snapshot()).toHaveLength(1);
    expect(buf.formatForAi()).toContain('[es]');
  });

  it('keeps resolver commentary events', () => {
    const buf = new CommentaryBuffer();
    buf.push({
      gameId: 'g1',
      ts: 1,
      type: 'play_end',
      text: 'Short pass from the free kick.',
      meta: { source: 'espn.commentary', clock: "5'" },
    });
    expect(buf.snapshot()).toHaveLength(1);
  });
});

describe('AuditLog + FeedMetrics', () => {
  it('records and caps entries', () => {
    const log = new AuditLog();
    log.record('market_open', { q: 'test' }, 'm1');
    expect(log.recent(5)).toHaveLength(1);
    const m = new FeedMetrics();
    m.recordPoll(12, 3);
    expect(m.snapshot(0, 0).pollCount).toBe(1);
  });
});

describe('LagMeter', () => {
  it('detects wallclock staleness', () => {
    const meter = new LagMeter();
    const old = new Date(Date.now() - 200_000).toISOString();
    meter.observe(
      { gameId: 'g1', ts: 1, type: 'attack', text: 'x', meta: { wallclock: old, clock: "20'" } },
      game,
    );
    expect(meter.isWallclockStale()).toBe(true);
  });
});
