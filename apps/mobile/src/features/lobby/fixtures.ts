/**
 * LOBBY FIXTURES — the mock slate of matches shown on the Play tab.
 *
 * These are presentational only (crests, scores, league, live-market counts).
 * The single LIVE "now playing" fixture mirrors the offline SimMatch
 * (Argentina vs France) so tapping the hero drops you into the real match loop
 * with continuity. Everything here is play-data: no network, no backend.
 *
 * Crests are not image assets — each team carries two brand colors and an
 * abbreviation, and the UI renders a tasteful gradient "crest" chip from them.
 * This keeps the bundle asset-free while still feeling like a real sportsbook.
 */

export type FixtureStatus = "live" | "upcoming" | "soon" | "final";

export interface FixtureTeam {
  abbr: string;
  name: string;
  /** Two brand colors → a gradient crest. */
  colors: [string, string];
  /** Country flag emoji for national teams (World Cup slate). Absent for clubs. */
  flag?: string;
}

export interface Fixture {
  id: string;
  league: string;
  /** Soccer/football for the slate; emoji used as a tiny league glyph. */
  sportGlyph: string;
  home: FixtureTeam;
  away: FixtureTeam;
  status: FixtureStatus;
  /** Live scoreline (live only). */
  scoreHome?: number;
  scoreAway?: number;
  /** "62'" for live, "Today 20:45" / "Sat 16:00" for upcoming. */
  clock: string;
  /**
   * Scheduled kickoff time as epoch milliseconds, when known (real feed only).
   * Drives the live countdown on upcoming rows. Absent → fall back to `clock`.
   */
  kickoff?: number;
  /** Open in-play markets right now (drives the "X live markets" chip). */
  liveMarkets: number;
  /** Hot moment headline for the live hero ("Argentina on the attack…"). */
  hotMoment?: string;
  /** True for the one fixture that maps to the real offline sim loop. */
  isSim?: boolean;
}

/** The headline LIVE match — this is the one wired to the real match loop. */
export const SIM_FIXTURE_ID = "sim-arg-fra";

export const FIXTURES: Fixture[] = [
  {
    id: SIM_FIXTURE_ID,
    league: "Friendly · International",
    sportGlyph: "",
    home: { abbr: "ARG", name: "Argentina", colors: ["#7cc3ff", "#3d7cff"], flag: "🇦🇷" },
    away: { abbr: "FRA", name: "France", colors: ["#3a5cff", "#1b2bb8"], flag: "🇫🇷" },
    status: "live",
    scoreHome: 1,
    scoreAway: 1,
    clock: "62'",
    liveMarkets: 5,
    hotMoment: "Argentina breaking forward — GOAL?",
    isSim: true,
  },
  {
    id: "mci-liv",
    league: "Premier League",
    sportGlyph: "",
    home: { abbr: "MCI", name: "Man City", colors: ["#8ec8ff", "#4aa6e0"] },
    away: { abbr: "LIV", name: "Liverpool", colors: ["#ff5d6c", "#c8102e"] },
    status: "live",
    scoreHome: 2,
    scoreAway: 2,
    clock: "78'",
    liveMarkets: 7,
    hotMoment: "Corner to Liverpool in the dying minutes…",
  },
  {
    id: "rma-bar",
    league: "LaLiga · El Clásico",
    sportGlyph: "",
    home: { abbr: "RMA", name: "Real Madrid", colors: ["#f4f6fb", "#c9ccd6"] },
    away: { abbr: "BAR", name: "Barcelona", colors: ["#b3308f", "#5b1fb0"] },
    status: "live",
    scoreHome: 0,
    scoreAway: 1,
    clock: "34'",
    liveMarkets: 4,
    hotMoment: "Free kick Real Madrid, dangerous spot…",
  },
  {
    id: "bay-dor",
    league: "Bundesliga · Der Klassiker",
    sportGlyph: "",
    home: { abbr: "BAY", name: "Bayern", colors: ["#ff5d6c", "#d40026"] },
    away: { abbr: "DOR", name: "Dortmund", colors: ["#ffd84a", "#f5b400"] },
    status: "soon",
    clock: "Today 20:45",
    liveMarkets: 0,
  },
  {
    id: "juv-int",
    league: "Serie A · Derby d’Italia",
    sportGlyph: "",
    home: { abbr: "JUV", name: "Juventus", colors: ["#e8eaf0", "#9aa0ad"] },
    away: { abbr: "INT", name: "Inter", colors: ["#3aa0ff", "#1428a0"] },
    status: "upcoming",
    clock: "Tomorrow 18:00",
    liveMarkets: 0,
  },
  {
    id: "psg-mar",
    league: "Ligue 1 · Le Classique",
    sportGlyph: "",
    home: { abbr: "PSG", name: "Paris SG", colors: ["#3a6bff", "#1b2bb8"] },
    away: { abbr: "MAR", name: "Marseille", colors: ["#7cd8ff", "#16a6d4"] },
    status: "upcoming",
    clock: "Sat 16:00",
    liveMarkets: 0,
  },
];

export const liveFixtures = (f = FIXTURES) =>
  f.filter((x) => x.status === "live");

/**
 * "Coming up" = genuinely not-yet-live fixtures only: status 'upcoming' | 'soon'.
 * FINISHED games (status 'final' / full-time) are deliberately excluded — a match
 * that's already over has no place in the live lobby. The sim/demo fixture is
 * also excluded (it's either the playable hero or already live), so it never
 * duplicates into the upcoming slate. Sorted soonest-first by kickoff when known.
 */
export const upcomingFixtures = (f = FIXTURES) =>
  f
    .filter(
      (x) =>
        (x.status === "upcoming" || x.status === "soon") && !x.isSim,
    )
    .sort((a, b) => (a.kickoff ?? Infinity) - (b.kickoff ?? Infinity));

/**
 * The single soonest upcoming fixture — the "next game" shown when nothing is
 * live. null when the slate has no upcoming matches at all.
 */
export const nextFixture = (f = FIXTURES): Fixture | null =>
  upcomingFixtures(f)[0] ?? null;

/**
 * Pure countdown formatter. Takes the milliseconds until kickoff (caller
 * supplies the delta — this module never reads the clock) and returns a compact
 * label: "Kicks off · 2d 4h", "1h 12m", "08:45", "Kicking off". Returns null
 * once kickoff has passed so callers can fall back to a schedule label.
 */
export function formatCountdown(msUntilKickoff: number): string | null {
  if (!Number.isFinite(msUntilKickoff)) return null;
  if (msUntilKickoff <= 0) return null;

  const totalSeconds = Math.floor(msUntilKickoff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  // Under an hour: a ticking mm:ss so the row feels live as kickoff nears.
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${mm}:${ss}`;
}
