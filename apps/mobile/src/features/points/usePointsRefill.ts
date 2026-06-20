import { useCallback, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { connectFeed, type FeedSocket } from "@/lib/ws";
import { POINTS_REFILL_THRESHOLD } from "@golazo/core";

/** Send a paper-trade points refill when balance is low. */
export function usePointsRefill() {
  const store = useStore();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const socketRef = useRef<FeedSocket | null>(null);

  const needsRefill = store.session.moneyMode === "points" &&
    store.pointsBalance < POINTS_REFILL_THRESHOLD;

  const refill = useCallback(() => {
    const userId = store.session.pointsUserId;
    if (!userId || loading) return;
    setLoading(true);
    setMessage(null);
    socketRef.current?.close();
    const socket = connectFeed(store.liveUrl, {
      onOpen: () => {
        socket.send({ t: "hello", userId: "refill" });
        socket.send({ t: "points_hello", userId, name: store.session.displayName ?? "Player" });
        socket.send({ t: "points_refill", userId });
      },
      onMessage: (msg) => {
        if (msg.t === "points_state" && msg.userId === userId) {
          store.setPointsState(msg.balance, msg.rank);
          setMessage(`Topped up to ${msg.balance.toLocaleString()} pts`);
          setLoading(false);
          socket.close();
        }
        if (msg.t === "points_refill_rejected" && msg.userId === userId) {
          setMessage(msg.reason);
          setLoading(false);
          socket.close();
        }
      },
      onClose: () => {
        setLoading(false);
      },
    });
    socketRef.current = socket;
  }, [store, loading]);

  return { needsRefill, refill, loading, message, clearMessage: () => setMessage(null) };
}
