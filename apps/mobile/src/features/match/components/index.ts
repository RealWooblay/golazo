/**
 * MATCH COMPONENTS — the building blocks of the live "bet the play" screen.
 *
 * Each composes from '@/ui' + '@/theme' and is web-safe (SVG/reanimated only, no
 * native-only deps). The screen (app/match/[id].tsx) wires them to useGameFeed.
 */
export { LiveScoreboard } from "./LiveScoreboard";
export { CommentaryTicker } from "./CommentaryTicker";
export { MarketCard } from "./MarketCard";
export { BetButton } from "./BetButton";
export { RevealCard } from "./RevealCard";
export { ClosedMarketsList } from "./ClosedMarketsList";
export { WaitingCard } from "./WaitingCard";
export { FullTimeCard } from "./FullTimeCard";
export { MatchFriendsBar } from "./MatchFriendsBar";
export { GlowWash } from "./GlowWash";
