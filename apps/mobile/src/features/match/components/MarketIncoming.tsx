import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { hapticIf } from "@/ui/haptics";

/**
 * MarketIncoming — the "get ready, a new market is dropping" telegraph for the idle slot.
 *
 * The server sends an ETA (ms) while a market is queued behind the flow pacer. We re-arm a local
 * target from it and run a SMOOTH countdown so the number ticks down cleanly between the server's
 * (throttled) updates, with a single buzz at 3, 2 and 1 second. Renders nothing when nothing is
 * pending. Purely cosmetic — it never gates a bet or a resolution.
 */
export function MarketIncoming({
  etaMs,
  hapticsEnabled = true,
}: {
  etaMs: number | null;
  hapticsEnabled?: boolean;
}) {
  const targetRef = useRef<number | null>(null);
  const lastBuzzRef = useRef(99);
  const [secs, setSecs] = useState(0);

  // Re-arm the countdown target whenever a fresh ETA arrives (or clear it when it ends).
  useEffect(() => {
    if (etaMs == null) {
      targetRef.current = null;
      lastBuzzRef.current = 99;
      setSecs(0);
      return;
    }
    targetRef.current = Date.now() + etaMs;
  }, [etaMs]);

  // Smooth local tick + 3·2·1 buzz toward the target.
  useEffect(() => {
    if (etaMs == null) return;
    const id = setInterval(() => {
      const target = targetRef.current;
      if (target == null) return;
      const left = Math.max(0, target - Date.now());
      const s = Math.ceil(left / 1000);
      setSecs(s);
      if (s >= 1 && s <= 3 && s < lastBuzzRef.current) {
        lastBuzzRef.current = s;
        hapticIf(hapticsEnabled, "selection");
      }
    }, 200);
    return () => clearInterval(id);
  }, [etaMs, hapticsEnabled]);

  if (etaMs == null) return null;
  const label = secs > 0 ? `Next market in ${secs}s` : "Next market dropping…";

  return (
    <View style={styles.wrap}>
      <View style={styles.dot} />
      <Text style={styles.text}>{label}</Text>
      <Text style={styles.ready}>GET READY</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    alignSelf: "center",
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface0,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.yes },
  text: { ...type.bodyStrong, fontSize: 13, color: colors.textPrimary },
  ready: { ...type.overline, fontSize: 8.5, letterSpacing: 0.8, color: colors.yes },
});
