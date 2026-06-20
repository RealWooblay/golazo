/** Structured, in-memory audit trail for market lifecycle + fairness decisions. */

export type AuditKind =
  | 'market_open'
  | 'market_skip'
  | 'market_lock'
  | 'market_resolve'
  | 'market_void'
  | 'watcher_ai'
  | 'watcher_rules'
  | 'watcher_skip'
  | 'lag_void'
  | 'batch_judge'
  | 'feed_poll'
  | 'play_phase';

export interface AuditEntry {
  ts: number;
  kind: AuditKind;
  marketId?: string;
  detail: Record<string, string | number | boolean | null | undefined>;
}

const MAX = 500;

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(kind: AuditKind, detail: AuditEntry['detail'], marketId?: string): void {
    this.entries.push({ ts: Date.now(), kind, detail, ...(marketId ? { marketId } : {}) });
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
  }

  recent(limit = 50): readonly AuditEntry[] {
    return this.entries.slice(-limit);
  }

  countByKind(): Record<AuditKind, number> {
    const out = {} as Record<AuditKind, number>;
    for (const e of this.entries) out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
  }
}
