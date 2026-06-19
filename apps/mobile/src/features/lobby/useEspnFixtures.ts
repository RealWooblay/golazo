import { useCallback, useEffect, useState } from "react";
import { SIM_FIXTURE_ID, type Fixture } from "./fixtures";
import { fetchFixtures, WORLD_CUP_LEAGUE } from "./espn";

/**
 * useLobbyFixtures — the lobby's match slate. REAL games only.
 *
 * The lobby NEVER shows anything fake: it fetches real World Cup fixtures from
 * ESPN and shows live + upcoming. When nothing is live (or the feed is
 * unreachable) the lobby is simply empty — the demo game is loaded explicitly
 * from Profile → Demo match, not surfaced here.
 */

export interface LobbyFixtures {
  fixtures: Fixture[];
  loading: boolean;
  /** null = ok; string = empty/why (the lobby shows an empty state, never fakes). */
  error: string | null;
  source: "real";
  refresh: () => void;
}

export function useLobbyFixtures(
  league: string = WORLD_CUP_LEAGUE,
): LobbyFixtures {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const real = await fetchFixtures(league);
      const rank = (f: Fixture) =>
        f.status === "live"
          ? 0
          : f.status === "upcoming" || f.status === "soon"
            ? 1
            : 2;
      real.sort((a, b) => rank(a) - rank(b));
      setFixtures(real); // REAL only — no sim/demo ever in the lobby
      setError(real.length ? null : "No live games right now.");
    } catch (e) {
      setFixtures([]); // no fake fallback — empty lobby instead
      setError(
        e instanceof Error ? e.message : "Could not reach the live feed.",
      );
    } finally {
      setLoading(false);
    }
  }, [league]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    fixtures,
    loading,
    error,
    source: "real",
    refresh: () => void load(),
  };
}

export { SIM_FIXTURE_ID };
