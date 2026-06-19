import type { GameState, TeamRef } from "@golazo/core";
import {
  FIXTURES,
  type Fixture,
  type FixtureTeam,
} from "@/features/lobby/fixtures";
import { flagFor } from "@/features/lobby/flags";

/**
 * TEAM IDENTITY for the match screen.
 *
 * The engine speaks in `TeamRef` (id/name/abbr/+ a single color). The crest
 * chip + the cinematic flank washes want two brand colors per side, which the
 * lobby fixtures already carry. This module bridges the two so the header always
 * has crests + tinted glows that match the lobby the user just tapped through.
 *
 * Resolution order:
 *   1. If the route `id` matches a lobby fixture, use that fixture's teams.
 *   2. Otherwise synthesise a FixtureTeam from the live GameState's TeamRef
 *      (deriving a second gradient stop from the provided color).
 *   3. Fall back to neutral grey badges before any state has arrived.
 */

/** Lighten a hex color toward white by `amt` (0..1) for a 2-stop gradient. */
function lighten(hex: string, amt = 0.32): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  const to2 = (c: number) => c.toString(16).padStart(2, "0");
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

const NEUTRAL: FixtureTeam = {
  abbr: "—",
  name: "Home",
  colors: ["#3a4154", "#232634"],
};
const NEUTRAL_AWAY: FixtureTeam = {
  abbr: "—",
  name: "Away",
  colors: ["#2a3040", "#1b1e29"],
};

function fromRef(
  ref: TeamRef | null | undefined,
  fallback: FixtureTeam,
): FixtureTeam {
  if (!ref) return fallback;
  const base = ref.color ?? fallback.colors[1];
  const flag = flagFor(ref.name);
  return {
    abbr: ref.abbr,
    name: ref.name,
    colors: [lighten(base), base],
    ...(flag ? { flag } : {}),
  };
}

export interface MatchTeams {
  home: FixtureTeam;
  away: FixtureTeam;
  league: string;
}

/**
 * Resolve the two teams (with crest colors) for the screen from the route id and
 * the live game state. Memo-friendly: pure, stable for the same inputs.
 */
export function resolveTeams(
  id: string | undefined,
  game: GameState | null,
): MatchTeams {
  const fixture: Fixture | undefined = id
    ? FIXTURES.find((f) => f.id === id)
    : undefined;
  if (fixture) {
    return { home: fixture.home, away: fixture.away, league: fixture.league };
  }
  return {
    home: fromRef(game?.home ?? null, NEUTRAL),
    away: fromRef(game?.away ?? null, NEUTRAL_AWAY),
    league: game?.league ?? "Live",
  };
}
