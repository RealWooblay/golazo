import type { FeedEvent, GameState, Team, TeamRef } from './types';

/**
 * SimMatch — a self-contained match simulator that emits the SAME normalized
 * FeedEvent stream a real provider would. It's the offline feed: the app runs
 * on it with zero network, and the service falls back to it when no real game
 * is live. Swap it for a real adapter and nothing downstream changes.
 *
 * It schedules its own events on an internal timeline and you pump it with
 * `due(now)`. Attacks are immediately followed (after the betting window) by a
 * resolving `goal`/`miss` event — so the watcher correlates them exactly like
 * it would with a real feed.
 *
 * TWO things keep the demo lifelike instead of a runaway scoreline:
 *
 *  1. ATTACKS stay FREQUENT but GOALS are RARE. The `prob` on each attack
 *     phrase seeds the MARKET odds (via `meta.prob`) so the betting card always
 *     has sane, lively pricing — but the actual SCORE/resolution rolls against a
 *     heavily scaled-down probability (`GOAL_SCALE`). So markets open every few
 *     seconds while a full 90' lands a realistic ~0–5 goals.
 *
 *  2. The match ENDS at 90' and AUTO-RESETS. When the display clock reaches
 *     full time we emit a single `final`, flip status to 'final', and stop
 *     generating scoring. After a short beat we reset clock AND score together
 *     into a fresh 0-0 'live' match and re-kick-off — so the demo runs forever
 *     without the score ballooning.
 */

export type Rng = () => number; // [0, 1)
export const defaultRng: Rng = () => Math.random();

const ATTACK_PHRASES: { type: FeedEvent['type']; prob: number; text: (t: string) => string }[] = [
  { type: 'dangerous_attack', prob: 0.34, text: (t) => `${t} break forward — through ball, this is dangerous!` },
  { type: 'dangerous_attack', prob: 0.4, text: (t) => `${t} counter 3-on-2, acres of space!` },
  { type: 'attack', prob: 0.16, text: (t) => `${t} knocking on the door, working an opening…` },
  { type: 'corner', prob: 0.15, text: (t) => `Corner to ${t}, whipped into the mixer…` },
  { type: 'free_kick', prob: 0.18, text: (t) => `Free kick ${t}, dangerous spot just outside the box 🎯` },
  { type: 'penalty', prob: 0.78, text: (t) => `PENALTY ${t}!! Up steps the taker…` },
];
const CALM = [
  'Knocking it around at the back.',
  'Midfield battle, nothing on yet.',
  'Throw-in, possession recycled.',
  'Keeper holds, slows the tempo.',
  'Patient build-up, probing for a gap.',
];
const MISS = [
  'SAVED!! Huge stop by the keeper.',
  'Blocked — last-ditch defending!',
  'OFF THE POST! Inches away.',
  'Dragged wide, head in hands.',
  'Cleared off the line!',
];

/**
 * How much to scale a phrase's MARKET probability DOWN when rolling the actual
 * goal. The phrase `prob` keeps the betting odds lively (a dangerous attack
 * still *looks* like a ~34% chance on the card), but the real score rolls
 * against `prob * GOAL_SCALE`.
 *
 * The real SCORE rolls against `phrase.prob * GOAL_SCALE`. Calibrated (see
 * sim.test.ts) so a full 90' lands a realistic football scoreline: mean ≈ 1.3
 * goals, ~26% nil-nil, capped in practice at ~5 — never a basketball score —
 * while the cadence below still opens a market every few seconds.
 */
const GOAL_SCALE = 0.65;

/** Display minutes in a full match. Real-time mapping is ~1 game-min / 900ms. */
const FULL_TIME_MIN = 90;
const HALF_TIME_MIN = 45;
const MS_PER_GAME_MIN = 900;
/** Wall-clock duration of one match, in ms (kickoff → 90'). */
const MATCH_MS = FULL_TIME_MIN * MS_PER_GAME_MIN;
/** When the clock reaches 45' — the half-time whistle. */
const HALF_AT_MS = HALF_TIME_MIN * MS_PER_GAME_MIN;
/** A SHORT half-time pause: betting closes, then the second half kicks off. Kept
 *  deliberately quick (and INSIDE the existing match window, so full-time timing
 *  is unchanged) — the clock keeps ticking under the HT badge. */
const HALFTIME_BEAT_MS = 4000;
/** Quiet beat between full time and the next kickoff, so the reset reads clean. */
const RESET_BEAT_MS = 6000;
/** Total length of one match CYCLE (play + final whistle beat). */
const CYCLE_MS = MATCH_MS + RESET_BEAT_MS;

/** Lifecycle status for a point `intoCycle` ms into the current match cycle. */
function statusFor(intoCycle: number): GameState['status'] {
  if (intoCycle >= MATCH_MS) return 'final';
  if (intoCycle >= HALF_AT_MS && intoCycle < HALF_AT_MS + HALFTIME_BEAT_MS)
    return 'halftime';
  return 'live';
}

let seq = 0;

export class SimMatch {
  readonly state: GameState;
  private rng: Rng;
  private queue: { at: number; ev: FeedEvent }[] = [];
  private nextPhaseAt: number;
  /** Wall-clock kickoff, so the display clock advances off ELAPSED time. */
  private readonly startAt: number;
  /** Which match cycle we're in (0-based). Bumps on every auto-reset. */
  private cycle = 0;
  /** Guard so we emit exactly one `final` per cycle. */
  private finalEmitted = false;
  /** Guard so we emit exactly one `halftime` per cycle. */
  private halftimeEmitted = false;

  constructor(opts: { gameId?: string; home?: TeamRef; away?: TeamRef; rng?: Rng; startAt: number }) {
    this.rng = opts.rng ?? defaultRng;
    this.startAt = opts.startAt;
    const home = opts.home ?? { id: 'arg', name: 'Argentina', abbr: 'ARG', color: '#6cb4ff' };
    const away = opts.away ?? { id: 'fra', name: 'France', abbr: 'FRA', color: '#2a4cff' };
    this.state = {
      gameId: opts.gameId ?? 'sim-arg-fra',
      sport: 'soccer',
      league: 'Friendly',
      home,
      away,
      scoreHome: 0,
      scoreAway: 0,
      clock: "0'",
      status: 'live',
    };
    this.push(opts.startAt, { type: 'kickoff', text: 'Kickoff — the match is underway!' });
    this.nextPhaseAt = opts.startAt + 2500;
  }

  /** Pop every event whose time has arrived, lazily scheduling the next phase. */
  due(now: number): FeedEvent[] {
    // Lifecycle FIRST: roll over to a fresh match if this cycle has elapsed, and
    // queue the half-time + final-whistle events. This is what makes the clock +
    // score reset *together* and stops the score ballooning past a real line.
    this.advanceLifecycle(now);

    // Advance the display clock + lifecycle status off ELAPSED wall time within
    // the current cycle (~1 game-min per 900ms, capped at 90'). Using per-cycle
    // elapsed (not absolute `now`) is what lets the clock reset to 0' next match.
    // Status (live → halftime → live → final) gates new market generation below,
    // so betting pauses at half time and full time.
    const intoCycle = Math.max(0, now - this.startAt - this.cycle * CYCLE_MS);
    const mins = Math.min(FULL_TIME_MIN, Math.floor(intoCycle / MS_PER_GAME_MIN));
    this.state.clock = `${mins}'`;
    this.state.status = statusFor(intoCycle);

    if (now >= this.nextPhaseAt && this.state.status === 'live') this.schedulePhase(this.nextPhaseAt);
    const out: FeedEvent[] = [];
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length && this.queue[0]!.at <= now) {
      out.push(this.queue.shift()!.ev);
    }
    return out;
  }

  /**
   * Drive the match clock through half time, full time, and into the next match.
   * Status itself is DERIVED in `due()` via `statusFor` (so it auto-resumes after
   * each pause); this method only handles the cycle ROLLOVER and queues the
   * one-shot `halftime` / `final` commentary events. The phase scheduler is gated
   * on status==='live', so no new markets open during either pause.
   *
   * - At 45': queue ONE `halftime` event (a brief betting pause).
   * - At 90': queue ONE `final` event (full time; scoring stops).
   * - Once the whole cycle (match + reset beat) has elapsed: RESET clock + score
   *   to a fresh 0-0 'live' match, advance the cycle counter, and re-kick-off.
   */
  private advanceLifecycle(now: number) {
    const elapsed = Math.max(0, now - this.startAt);
    const targetCycle = Math.floor(elapsed / CYCLE_MS);

    // Roll into a brand-new match: clock + score reset TOGETHER here.
    while (this.cycle < targetCycle) {
      this.cycle += 1;
      this.state.scoreHome = 0;
      this.state.scoreAway = 0;
      this.state.clock = "0'";
      this.state.status = 'live';
      this.finalEmitted = false;
      this.halftimeEmitted = false;
      // Drop any stale resolutions still queued from the previous match so they
      // can't score into the fresh 0-0.
      this.queue = [];
      const kickoffAt = this.startAt + this.cycle * CYCLE_MS;
      this.push(kickoffAt, { type: 'kickoff', text: 'Kickoff — fresh match, back to 0-0!' });
      this.nextPhaseAt = kickoffAt + 2500;
    }

    const intoCycle = elapsed - this.cycle * CYCLE_MS;
    const cycleStart = this.startAt + this.cycle * CYCLE_MS;

    // Half time at 45' — one short whistle. (Status flips via statusFor.)
    if (intoCycle >= HALF_AT_MS && !this.halftimeEmitted) {
      this.halftimeEmitted = true;
      this.push(cycleStart + HALF_AT_MS, {
        type: 'halftime',
        text: `Half time — ${this.state.home.abbr} ${this.state.scoreHome}–${this.state.scoreAway} ${this.state.away.abbr}`,
      });
    }

    // Full time at 90' — one whistle, scoring stops.
    if (intoCycle >= MATCH_MS && !this.finalEmitted) {
      this.finalEmitted = true;
      this.push(cycleStart + MATCH_MS, {
        type: 'final',
        text: `Full time! ${this.state.home.abbr} ${this.state.scoreHome}–${this.state.scoreAway} ${this.state.away.abbr}`,
      });
    }
  }

  private schedulePhase(at: number) {
    // Cadence is tuned to keep the betting drumbeat FREQUENT: fewer/shorter calm
    // lulls and tighter gaps mean a market opens every few seconds. (Goal RARITY
    // is handled separately via GOAL_SCALE — frequency and scoring are decoupled.)
    const calm = this.rng() < 0.35;
    if (calm) {
      this.push(at, { type: 'calm', text: pick(CALM, this.rng) });
      this.nextPhaseAt = at + 1400 + this.rng() * 1400;
      return;
    }
    const team: Team = this.rng() < 0.5 ? 'home' : 'away';
    const teamName = team === 'home' ? this.state.home.name : this.state.away.name;
    const phrase = pick(ATTACK_PHRASES, this.rng);
    const sequenceId = `seq_${++seq}`;
    const windowMs = phrase.type === 'penalty' ? 9000 : phrase.type === 'corner' || phrase.type === 'free_kick' ? 7000 : 6000;

    // 1) the attack (a "set" moment) — the watcher will open a market here.
    //    `meta.prob` is the MARKET seed and stays at the lively phrase prob.
    this.push(at, {
      type: phrase.type,
      team,
      text: phrase.text(teamName),
      meta: { prob: phrase.prob, sequenceId },
    });

    // 2) decide + schedule resolution AFTER the window closes.
    //    The SCORE rolls against a heavily scaled-down probability so goals are
    //    RARE even though the market looked like a real chance — this is the
    //    knob that keeps a 90' match to a realistic ~0–5 goals.
    const goal = this.rng() < phrase.prob * GOAL_SCALE;
    const resolveAt = at + windowMs + 1200 + this.rng() * 1400;
    if (goal) {
      this.push(resolveAt, {
        type: 'goal',
        team,
        text: `⚽ GOAL!!! ${teamName} score!`,
        meta: { sequenceId },
      });
    } else {
      this.push(resolveAt, { type: 'miss', team, text: pick(MISS, this.rng), meta: { sequenceId } });
    }
    this.nextPhaseAt = resolveAt + 1000 + this.rng() * 1200;
  }

  /** Apply a goal to the scoreline (host calls this when it sees a goal event). */
  applyGoal(team: Team) {
    if (team === 'home') this.state.scoreHome++;
    else this.state.scoreAway++;
  }

  setClock(clock: string) {
    this.state.clock = clock;
  }

  private push(at: number, ev: Omit<FeedEvent, 'gameId' | 'ts'>) {
    this.queue.push({ at, ev: { ...ev, gameId: this.state.gameId, ts: at } });
  }
}

function pick<T>(arr: T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
