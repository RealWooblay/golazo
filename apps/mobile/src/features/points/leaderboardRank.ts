import type { PointsPlayer } from "@golazo/core";

/** 1-based rank on the public board; 0 when `meId` is not ranked. */
export function rankOnLeaderboard(
  players: PointsPlayer[],
  meId: string | undefined,
): number {
  if (!meId) return 0;
  const idx = players.findIndex((p) => p.userId === meId);
  return idx < 0 ? 0 : idx + 1;
}
