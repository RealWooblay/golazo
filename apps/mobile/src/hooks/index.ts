/** Hook barrel. */
// useGameFeed now lives with the match feature it powers; re-exported here so
// existing `@/hooks` importers keep working through the move.
export { useGameFeed } from "@/features/match/useGameFeed";
export type { GameFeedApi, GameFeedVM } from "@/features/match/useGameFeed";
export { useTick } from "./useTick";
export { useBalance } from "./useBalance";
