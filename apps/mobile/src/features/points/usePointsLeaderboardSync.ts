import { useEffect } from "react";
import { useStore } from "@/state/store";
import { connectFeed } from "@/lib/ws";
import { usePointsIdentity } from "./usePointsIdentity";

/**
 * Keeps the ONE global points leaderboard fresh in BOTH modes — you earn points
 * on every bet (real + paper), so the board is always live. Lightweight WS —
 * hello + points_hello only; no match state. The points identity comes from
 * {@link usePointsIdentity}: a stable account id when signed in (so one account
 * is one leaderboard player on every device), else the device-local id.
 */
export function usePointsLeaderboardSync(enabled = true): void {
  const store = useStore();
  const { liveUrl } = store;
  const identity = usePointsIdentity();
  const { userId, name } = identity;

  useEffect(() => {
    if (!enabled) return;
    if (!userId) return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (cancelled) return;
      const socket = connectFeed(liveUrl, {
        onOpen: () => {
          if (cancelled) return;
          socket.send({ t: "hello", userId: "lb" });
          socket.send({
            t: "points_hello",
            userId,
            name,
          });
        },
        onClose: () => {
          if (cancelled) return;
          retry = setTimeout(connect, 3000);
        },
        onMessage: (msg) => {
          if (cancelled) return;
          if (msg.t === "points_leaderboard") {
            store.setPointsLeaderboard(msg.players);
          }
          if (msg.t === "points_state" && msg.userId === userId) {
            store.setPointsState(msg.balance, msg.rank);
          }
        },
      });
      return socket;
    };

    const socket = connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [enabled, liveUrl, userId, name, store]);
}
