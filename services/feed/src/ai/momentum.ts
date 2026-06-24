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
import { resolveDeadlineMs } from './marketTuning';

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

/**
 * Per-heartbeat-tick decay. `observe()` decays ONLY per event, so during an event-free
 * lull the reading would FREEZE at its last value — and the heartbeat opener would then
 * keep printing "they're pressing!" markets off pressure that has actually died. A gentle
 * per-tick relaxation lets a quiet spell drift the reading back toward neutral (~80s to
 * fall a strong 3.0 read below the 1.6 open threshold), so markets track CURRENT play.
 */
const TICK_DECAY = 0.98;

/**
 * Pressure needed before the agent will spin up a market off momentum alone.
 * The GOAL bar sits high: a momentum "— GOAL?" market almost always resolves NO
 * (a pressing spell rarely yields a goal inside the window), so we reserve it for
 * genuinely relentless siege pressure and let lighter spells ask the answerable
 * "— SHOT?" instead. This stops the board filling with un-winnable "GOAL next?" spam.
 */
export const MOMENTUM_SHOT_THRESHOLD = 3.0; // legacy alias → see MOMENTUM_OPEN_THRESHOLD
export const MOMENTUM_GOAL_THRESHOLD = 5.0; // sustained siege → "to score in N min?"

/** Lean past this (0..1 toward a side) lights up the client momentum bar. */
const BAR_LEAN_MIN = 0.58;

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

  /** Wipe the tally — called on a match switch so momentum never carries over. */
  reset(): void {
    this.home = 0;
    this.away = 0;
  }

  /** Relax the reading one heartbeat tick toward neutral (called each live tick) so a
   *  quiet spell doesn't keep a stale-high reading that prints false-pressure markets. */
  decayTick(): void {
    this.home *= TICK_DECAY;
    this.away *= TICK_DECAY;
  }

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
  kind: 'shot_in_window' | 'score_in_window' | 'shot_or_corner_in_window';
  question: string;
  trueProb: number;
}

/** Whole minutes of the score_in_window resolve window — drives the CONCRETE title. */
function scoreWindowMinutes(): number {
  return Math.max(1, Math.round(resolveDeadlineMs('score_in_window') / 60_000));
}

/**
 * Turn a momentum read into a TIME-BOXED market — the bet is on a wall-clock
 * window ("this spell" / "the next N minutes"), not a play phase, which is what
 * makes it resolve reliably under feed lag. The harder the press, the bigger the
 * ask: sustained siege opens a "to score in the next N minutes?" (score_in_window);
 * lighter pressure asks the answerable "a shot next spell?" (shot_in_window).
 * Phrasing rotates by a counter so a long spell never repeats one line.
 *
 * The score_in_window title is CONCRETE — the "N minutes" is derived from the
 * actual resolve window (resolveDeadlineMs('score_in_window')), not a vague "few
 * minutes", so the card promises exactly the window it will be judged on.
 */
export function momentumMarketSpec(
  teamName: string,
  intensity: number,
  counter: number,
): MomentumMarketSpec {
  if (intensity >= MOMENTUM_GOAL_THRESHOLD) {
    const mins = scoreWindowMinutes();
    const unit = mins === 1 ? 'minute' : 'minutes';
    const scoreLines = [
      `${teamName} to score in ${mins} ${unit}?`,
      `Can ${teamName} score in ${mins} ${unit}?`,
      `Goal for ${teamName} in ${mins} ${unit}?`,
      `${teamName} to break through in ${mins} ${unit}?`,
      `${teamName} to find a goal in ${mins} ${unit}?`,
      `${teamName} to score in the next ${mins} ${unit}?`,
    ];
    return {
      kind: 'score_in_window',
      question: scoreLines[counter % scoreLines.length]!,
      trueProb: 0.22,
    };
  }
  // Alternate the lighter-pressure window between the narrow "a SHOT next spell?" and
  // the BROADER "a SHOT or CORNER next spell?" (a wider, higher-YES question) so the
  // momentum board varies and resolves YES more often. Even counter → shot-or-corner.
  if (counter % 2 === 0) {
    const broadLines = [
      `${teamName} shot or corner next?`,
      `Shot or corner for ${teamName} next?`,
      `${teamName} to win a shot or corner?`,
    ];
    return {
      kind: 'shot_or_corner_in_window',
      question: broadLines[(counter >> 1) % broadLines.length]!,
      trueProb: 0.5,
    };
  }
  const shotLines = [
    `${teamName} to get a shot next?`,
    `Shot for ${teamName} next?`,
    `${teamName} shot incoming?`,
    `${teamName} to test the keeper?`,
    `${teamName} to create a chance?`,
    `Next shot from ${teamName}?`,
  ];
  return {
    kind: 'shot_in_window',
    question: shotLines[counter % shotLines.length]!,
    trueProb: 0.4,
  };
}
