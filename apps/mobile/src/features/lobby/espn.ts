/**
 * REAL World Cup fixtures from ESPN's free, key-less JSON API.
 *
 * GET https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard
 *
 * ESPN serves `access-control-allow-origin: *`, so the app can fetch this
 * directly on both web and native — no proxy or key needed. We map each event
 * into the lobby's existing {@link Fixture} shape (real teams, abbreviations,
 * brand colors, live scores + status), so the Play tab renders REAL matches.
 *
 * This is genuine live data (delayed, free tier — not the low-latency official
 * betting feed, which is licensed/exclusive). Good enough to show the real slate
 * and, when a match is in play, to drive real in-game moments.
 */

import type { Fixture, FixtureStatus, FixtureTeam } from "./fixtures";
import { flagFor } from "./flags";

/** Default league: the FIFA World Cup. Others: 'eng.1', 'esp.1', 'usa.1'… */
export const WORLD_CUP_LEAGUE = "fifa.world";

const SCOREBOARD = (league: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;

const FETCH_TIMEOUT_MS = 8000;

// --- minimal structural types for the bits of ESPN we read ---
interface EspnTeam {
  id?: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  color?: string;
  alternateColor?: string;
}
interface EspnCompetitor {
  homeAway?: "home" | "away";
  score?: string;
  team?: EspnTeam;
}
interface EspnEvent {
  id?: string;
  shortName?: string;
  /** ISO-8601 scheduled kickoff, e.g. "2026-06-21T16:00Z". */
  date?: string;
  status?: {
    type?: {
      state?: "pre" | "in" | "post";
      shortDetail?: string;
      detail?: string;
    };
    displayClock?: string;
  };
  competitions?: { competitors?: EspnCompetitor[] }[];
  season?: { slug?: string };
}
interface EspnScoreboard {
  leagues?: { name?: string; abbreviation?: string }[];
  events?: EspnEvent[];
}

/** Fetch the real fixtures for a league (default: World Cup). */
export async function fetchFixtures(
  league: string = WORLD_CUP_LEAGUE,
): Promise<Fixture[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SCOREBOARD(league), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const data = (await res.json()) as EspnScoreboard;
    const leagueName = data.leagues?.[0]?.name ?? "FIFA World Cup";
    return (data.events ?? [])
      .map((e) => mapEvent(e, leagueName))
      .filter((f): f is Fixture => f !== null);
  } finally {
    clearTimeout(timer);
  }
}

function mapEvent(ev: EspnEvent, leagueName: string): Fixture | null {
  const comp = ev.competitions?.[0];
  const cs = comp?.competitors ?? [];
  const home = cs.find((c) => c.homeAway === "home");
  const away = cs.find((c) => c.homeAway === "away");
  if (!home || !away || !ev.id) return null;

  const state = ev.status?.type?.state ?? "pre";
  const status: FixtureStatus =
    state === "in" ? "live" : state === "post" ? "final" : "upcoming";
  const detail = ev.status?.type?.shortDetail ?? ev.status?.displayClock ?? "";

  const fixture: Fixture = {
    id: ev.id,
    league: leagueName,
    sportGlyph: "",
    home: team(home.team),
    away: team(away.team),
    status,
    clock:
      status === "live"
        ? ev.status?.displayClock || detail || "LIVE"
        : detail || "TBD",
    liveMarkets: status === "live" ? 1 : 0,
  };
  // Scheduled kickoff → epoch ms, so upcoming rows can render a live countdown.
  if (status === "upcoming" && ev.date) {
    const t = Date.parse(ev.date);
    if (Number.isFinite(t)) fixture.kickoff = t;
  }
  if (status !== "upcoming") {
    fixture.scoreHome = toInt(home.score);
    fixture.scoreAway = toInt(away.score);
  }
  // NO synthetic "hot moment". The free ESPN feed is delayed and carries no
  // real in-play moment signal, so anything we'd put here ("X pushing — next
  // goal?") would be invented. We leave hotMoment unset and the live card simply
  // omits it — a fabricated urgency line is worse than none.
  return fixture;
}

function team(t: EspnTeam | undefined): FixtureTeam {
  const name = t?.shortDisplayName || t?.displayName || "Unknown";
  const c1 = hex(t?.color) ?? "#3a6bff";
  const c2 = hex(t?.alternateColor) ?? darken(c1, 0.55);
  // National teams (the World Cup slate) get a flag; try the full display name
  // first (e.g. "United States") then the short name, so variants resolve.
  const flag = flagFor(t?.displayName) ?? flagFor(name);
  return {
    abbr: (t?.abbreviation || name.slice(0, 3)).toUpperCase(),
    name,
    colors: [c1, c2],
    ...(flag ? { flag } : {}),
  };
}

function hex(c: string | undefined): string | null {
  if (!c) return null;
  const v = c.replace("#", "").trim();
  // ESPN sometimes returns pure white/black which looks flat — keep it; the
  // second stop is derived to give the crest some depth.
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : null;
}

/** Darken a #rrggbb by factor (0..1). Used to derive a gradient second stop. */
function darken(hexColor: string, factor: number): string {
  const v = hexColor.replace("#", "");
  const n = parseInt(v, 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.round((n & 0xff) * factor));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function toInt(s: string | undefined): number {
  const n = Number.parseInt(s ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}
