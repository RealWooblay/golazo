// FRIENDS ROOM PROVIDER — one shared room instance for the whole friends flow.
//
// Mounted ONCE above the navigator (root layout), so the entry screen, the join
// screen, and the room screen all read/drive the SAME useFriendsRoom instance —
// i.e. the SAME WebSocket and the SAME room membership. Without this, each screen
// would mount its own hook + socket, and the room would be dropped the instant the
// creating screen navigated away. The underlying socket is lazy: nothing connects
// until the first createRoom/joinRoom.
import React, { createContext, useContext } from "react";
import { useFriendsRoom, type UseFriendsRoom } from "./useFriendsRoom";

const FriendsRoomContext = createContext<UseFriendsRoom | null>(null);

export function FriendsRoomProvider({ children }: { children: React.ReactNode }) {
  const room = useFriendsRoom();
  return (
    <FriendsRoomContext.Provider value={room}>
      {children}
    </FriendsRoomContext.Provider>
  );
}

/** Access the shared friends-room instance. Throws if used outside the provider. */
export function useFriendsRoomContext(): UseFriendsRoom {
  const ctx = useContext(FriendsRoomContext);
  if (!ctx) {
    throw new Error(
      "useFriendsRoomContext must be used within a <FriendsRoomProvider>.",
    );
  }
  return ctx;
}
