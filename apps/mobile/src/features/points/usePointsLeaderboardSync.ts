import { useEffect } from "react";
import { useStore } from "@/state/store";
import { connectFeed } from "@/lib/ws";
import { USER_ID } from "@/lib/config";

/**
 * Keeps the ONE global points leaderboard fresh in BOTH modes — you earn points
 * on every bet (real + paper), so the board is always live. Lightweight WS —
 * hello + points_hello only; no match state. The points identity matches the
 * bet that earns the points: pointsUserId in paper mode, the engine USER_ID in
 * real mode (real bets settle under USER_ID), so "your standing" lines up either way.
 */
export function usePointsLeaderboardSync(enabled = true): void {
  const store = useStore();
  const { liveUrl, session } = store;

  useEffect(() => {
    if (!enabled) return;
    const userId =
      session.moneyMode === "points" ? session.pointsUserId : USER_ID;
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
            name: session.displayName ?? "Player",
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
  }, [
    enabled,
    liveUrl,
    session.moneyMode,
    session.pointsUserId,
    session.displayName,
    store,
  ]);
}
