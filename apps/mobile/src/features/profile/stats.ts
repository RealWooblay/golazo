import type { BetRow, HistoryItem } from "@/state";

/**
 * PROFILE STATS — pure derivations over the persisted ledger. Kept dependency-free
 * and side-effect-free so the Profile screen just reads them (and they're trivial
 * to unit-test). A "win" is a settled bet with won=true; a VOID refund counts
 * as neither a win nor a loss.
 */

export interface LifetimeStats {
  /** Count of settled (non-void) bets. */
  settled: number;
  /** Wins / settled, 0..1. */
  winRate: number;
  wins: number;
  losses: number;
  /** Total amount staked across all bets. */
  wagered: number;
  /** Net profit/loss across all bets (sum of deltas). */
  net: number;
  /** Largest single winning delta (0 if none). */
  biggestWin: number;
  /** Current win/loss streak: positive = wins, negative = losses, 0 = none. */
  streak: number;
  /** Best winning streak ever. */
  bestStreak: number;
  /** Total bets placed (includes voids). */
  totalBets: number;
}

/** A bet counts as "settled" for win-rate if it wasn't a void refund. */
function isVoid(b: BetRow): boolean {
  // A void refunds the stake → delta 0 and not flagged won.
  return !b.won && b.delta === 0;
}

export function lifetimeStats(bets: BetRow[]): LifetimeStats {
  let wins = 0;
  let losses = 0;
  let wagered = 0;
  let net = 0;
  let biggestWin = 0;
  let totalBets = bets.length;

  for (const b of bets) {
    wagered += b.stake;
    net += b.delta;
    if (isVoid(b)) continue;
    if (b.won) {
      wins += 1;
      if (b.delta > biggestWin) biggestWin = b.delta;
    } else {
      losses += 1;
    }
  }

  const settled = wins + losses;
  const winRate = settled > 0 ? wins / settled : 0;

  // Streak: walk newest → oldest (bets are already newest-first), skip voids.
  let streak = 0;
  for (const b of bets) {
    if (isVoid(b)) continue;
    if (streak === 0) {
      streak = b.won ? 1 : -1;
    } else if (b.won && streak > 0) {
      streak += 1;
    } else if (!b.won && streak < 0) {
      streak -= 1;
    } else {
      break;
    }
  }

  // Best win streak ever (oldest → newest).
  let bestStreak = 0;
  let run = 0;
  for (let i = bets.length - 1; i >= 0; i--) {
    const b = bets[i];
    if (isVoid(b)) continue;
    if (b.won) {
      run += 1;
      if (run > bestStreak) bestStreak = run;
    } else {
      run = 0;
    }
  }

  return {
    settled,
    winRate,
    wins,
    losses,
    wagered,
    net,
    biggestWin,
    streak,
    bestStreak,
    totalBets,
  };
}

/** "62%" — win rate as a rounded percent string. */
export function winRatePct(s: LifetimeStats): string {
  return `${Math.round(s.winRate * 100)}%`;
}

/** "W3" / "L2" / "—" — compact streak badge text. */
export function streakLabel(streak: number): string {
  if (streak === 0) return "—";
  return (streak > 0 ? "W" : "L") + Math.abs(streak);
}

// ── Ledger filtering + relative time ─────────────────────────────────────────

export type LedgerFilter = "all" | "bets" | "cash";

export function filterLedger(
  items: HistoryItem[],
  filter: LedgerFilter,
): HistoryItem[] {
  if (filter === "all") return items;
  if (filter === "bets") return items.filter((i) => i.kind === "bet");
  return items.filter((i) => i.kind === "transaction");
}

/** "now" / "12m" / "3h" / "2d" / "Jun 3" — compact relative timestamp. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
