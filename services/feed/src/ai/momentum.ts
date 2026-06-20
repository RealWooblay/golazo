/**
 * MOMENTUM — the agent's read of "who is pressing right now," derived live from
 * the event stream. It does two jobs:
 *   1. Drives the session-overview momentum bar (home ↔ away lean).
 *   2. DECIDES markets: sustained pressure opens a forward-looking chance. A team
 *      that's really on top gets a "— GOAL?" market; lighter pressure a "— SHOT?".
 *
 * It's a decaying, weighted tally: each new event nudges the pressing side up and
 * bleeds the prior reading down, so momentum naturally swings with the run of play
 * and cools off when the game goes quiet.
 */
import type { FeedEvent, Team } from '@golazo/core';

/** How much each event type signals attacking pressure for the team that caused it. */
const WEIGHTS: Partial<Record<FeedEvent['type'], number>> = {
  goal: 4,
  penalty: 4,
  dangerous_attack: 3,
  shot: 2.5,
  miss: 2, // a shot that missed/was saved/blocked — still real pressure
  corner: 1.6,
  attack: 1.4,
  free_kick: 1,
};

/** Each observed event decays the standing reading — momentum is recency-weighted. */
const DECAY = 0.8;

/** Pressure needed before the agent will spin up a market off momentum alone. */
export const MOMENTUM_SHOT_THRESHOLD = 3.0; // "— SHOT?" (chance_from_play)
export const MOMENTUM_GOAL_THRESHOLD = 5.5; // "— GOAL?" (goal_from_open_play)

/** Lean past this (0..1 toward a side) lights up the client momentum bar. */
const BAR_LEAN_MIN = 0.6;

export interface MomentumRead {
  /** Raw decaying pressure per side. */
  home: number;
  away: number;
  /** Which side is pressing (undefined = even / quiet). */
  leader?: Team;
  /** The leader's pressure value (0 when even). */
  intensity: number;
  /** 'home' | 'away' for the UI bar, or null when it should rest neutral. */
  bar: Team | null;
}

export class MomentumTracker {
  private home = 0;
  private away = 0;

  /** Fold one event into the running momentum. */
  observe(ev: FeedEvent): void {
    this.home *= DECAY;
    this.away *= DECAY;
    const w = WEIGHTS[ev.type];
    if (!w || !ev.team) return;
    if (ev.team === 'home') this.home += w;
    else this.away += w;
  }

  read(): MomentumRead {
    const home = round(this.home);
    const away = round(this.away);
    const leader: Team | undefined = home === away ? undefined : home > away ? 'home' : 'away';
    const intensity = leader === 'home' ? home : leader === 'away' ? away : 0;
    const total = home + away;
    const lean = total > 0 && leader ? intensity / total : 0.5;
    const bar = leader && lean >= BAR_LEAN_MIN ? leader : null;
    return { home, away, leader, intensity, bar };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface MomentumMarketSpec {
  kind: 'goal_from_open_play' | 'chance_from_play';
  question: string;
  trueProb: number;
}

/**
 * Turn a momentum read into the market to open — VARIED so a relentless spell
 * doesn't print the same line 18 times. The harder the press, the bigger the ask
 * (GOAL vs SHOT); phrasing rotates by a counter and nods to what just happened.
 */
export function momentumMarketSpec(
  teamName: string,
  intensity: number,
  trigger: 'shot' | 'miss' | 'other',
  counter: number,
): MomentumMarketSpec {
  if (intensity >= MOMENTUM_GOAL_THRESHOLD) {
    const goalLines = [
      `${teamName} all over them — GOAL next?`,
      `${teamName} pressing hard — GOAL incoming?`,
      `${teamName} piling it on — do they SCORE?`,
      `${teamName} laying siege — GOAL this spell?`,
    ];
    return {
      kind: 'goal_from_open_play',
      question: goalLines[counter % goalLines.length]!,
      trueProb: 0.22,
    };
  }
  const shotLines =
    trigger === 'miss'
      ? [
          `${teamName} keep coming — another SHOT?`,
          `${teamName} on top — SHOT next?`,
        ]
      : [
          `${teamName} building — SHOT this move?`,
          `${teamName} pushing forward — get a SHOT away?`,
        ];
  return {
    kind: 'chance_from_play',
    question: shotLines[counter % shotLines.length]!,
    trueProb: 0.4,
  };
}
