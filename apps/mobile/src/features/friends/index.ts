/**
 * FRIENDS MODE — public surface for the in-app private friends rooms.
 *
 * The UI builds against this barrel: the `useFriendsRoom` hook (transport +
 * authoritative view model), the `buildInviteLink` helper, the hook's own types,
 * and a convenience re-export of the core room types so screens can import
 * everything room-related from one place.
 */
export { useFriendsRoom } from "./useFriendsRoom";
export type {
  UseFriendsRoom,
  FriendsRoomReveal,
  RoomConnState,
} from "./useFriendsRoom";

// Shared instance for the friends flow (entry → join → room). Screens consume
// useFriendsRoomContext(); the provider is mounted once at the root layout.
export {
  FriendsRoomProvider,
  useFriendsRoomContext,
} from "./FriendsRoomProvider";

export { buildInviteLink } from "./invite";

// Re-export the core room types for convenience (UI imports them from here).
export type {
  RoomState,
  RoomMarket,
  RoomPlayer,
  RoomBet,
} from "@golazo/core";
