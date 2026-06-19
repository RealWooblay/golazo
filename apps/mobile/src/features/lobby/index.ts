/**
 * LOBBY FEATURE — barrel. The Play tab composes these:
 *   • LobbyTopBar   — brand + animated balance + Add cash
 *   • LiveHero      — the cinematic "now playing" centrepiece
 *   • FixtureRow    — compact tappable match row (live + upcoming lists)
 *   • LobbySkeleton — loading state mirroring the layout
 *   • Crest         — asset-free gradient team badge
 *   • fixtures      — the mock slate + helpers (live/upcoming)
 */
export { LobbyTopBar } from "./LobbyTopBar";
export { LiveHero } from "./LiveHero";
export { FixtureRow } from "./FixtureRow";
export { LobbySkeleton } from "./LobbySkeleton";
export { Crest } from "./Crest";

export {
  FIXTURES,
  SIM_FIXTURE_ID,
  liveFixtures,
  upcomingFixtures,
  nextFixture,
} from "./fixtures";
export type { Fixture, FixtureTeam, FixtureStatus } from "./fixtures";
