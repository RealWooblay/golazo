/** Lightweight runtime counters — exposed on /metrics for ops. */

export interface MetricsSnapshot {
  startedAt: number;
  uptimeMs: number;
  pollCount: number;
  pollErrors: number;
  lastPollMs: number;
  lastPollAgeMs: number;
  eventsProcessed: number;
  marketsOpened: number;
  marketsSkipped: number;
  marketsVoided: number;
  marketsResolved: number;
  aiBatchCalls: number;
  aiSingleCalls: number;
  aiSkips: number;
  rulesOpens: number;
  wsClients: number;
  roomCount: number;
  avgFeedLagMin: number;
  maxFeedLagMin: number;
  wallclockLagSec: number | null;
  playPhase: string;
}

export class FeedMetrics {
  readonly startedAt = Date.now();
  pollCount = 0;
  pollErrors = 0;
  lastPollMs = 0;
  lastPollAt = 0;
  eventsProcessed = 0;
  marketsOpened = 0;
  marketsSkipped = 0;
  marketsVoided = 0;
  marketsResolved = 0;
  aiBatchCalls = 0;
  aiSingleCalls = 0;
  aiSkips = 0;
  rulesOpens = 0;
  lagSamples: number[] = [];
  wallclockLagSec: number | null = null;
  playPhase = 'calm';

  recordPoll(durationMs: number, eventCount: number, error = false): void {
    this.pollCount++;
    if (error) this.pollErrors++;
    this.lastPollMs = durationMs;
    this.lastPollAt = Date.now();
    this.eventsProcessed += eventCount;
  }

  recordLag(minutes: number): void {
    this.lagSamples.push(minutes);
    if (this.lagSamples.length > 120) this.lagSamples.shift();
  }

  snapshot(wsClients: number, roomCount: number): MetricsSnapshot {
    const lags = this.lagSamples;
    const avg = lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;
    const max = lags.length ? Math.max(...lags) : 0;
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      pollCount: this.pollCount,
      pollErrors: this.pollErrors,
      lastPollMs: this.lastPollMs,
      lastPollAgeMs: this.lastPollAt ? Date.now() - this.lastPollAt : 0,
      eventsProcessed: this.eventsProcessed,
      marketsOpened: this.marketsOpened,
      marketsSkipped: this.marketsSkipped,
      marketsVoided: this.marketsVoided,
      marketsResolved: this.marketsResolved,
      aiBatchCalls: this.aiBatchCalls,
      aiSingleCalls: this.aiSingleCalls,
      aiSkips: this.aiSkips,
      rulesOpens: this.rulesOpens,
      wsClients,
      roomCount,
      avgFeedLagMin: Math.round(avg * 100) / 100,
      maxFeedLagMin: Math.round(max * 100) / 100,
      wallclockLagSec: this.wallclockLagSec,
      playPhase: this.playPhase,
    };
  }
}
