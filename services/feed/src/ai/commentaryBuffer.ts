import type { FeedEvent } from '@golazo/core';

const MAX_LINES = 24;

/** Rolling commentary window — richer context for batch AI without re-polling ESPN. */
export class CommentaryBuffer {
  private readonly lines: FeedEvent[] = [];

  push(ev: FeedEvent): void {
    if (ev.meta?.source === 'espn.commentary') {
      this.lines.push(ev);
      if (this.lines.length > MAX_LINES) this.lines.shift();
      return;
    }
    if (
      ev.type === 'attack' ||
      ev.type === 'dangerous_attack' ||
      ev.type === 'miss' ||
      ev.type === 'shot' ||
      ev.type === 'play_end'
    ) {
      this.lines.push(ev);
      if (this.lines.length > MAX_LINES) this.lines.shift();
    }
  }

  /** All commentary + fuzzy events in chronological order. */
  snapshot(): FeedEvent[] {
    return [...this.lines];
  }

  /** Format for AI prompts — bilingual tags preserved. */
  formatForAi(limit = 12): string {
    return this.lines
      .slice(-limit)
      .map((e) => {
        const lang = typeof e.meta?.lang === 'string' ? `[${e.meta.lang}] ` : '';
        const clock = typeof e.meta?.clock === 'string' ? `${e.meta.clock} ` : '';
        return `${lang}${clock}[${e.type}${e.team ? `/${e.team}` : ''}] ${e.text}`;
      })
      .join('\n');
  }

  clear(): void {
    this.lines.length = 0;
  }
}
