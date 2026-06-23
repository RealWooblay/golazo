import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import type { MarketVM } from "@/state/types";
import { eventDecidedLabel, isEventDecided, isWhistleBound, laneOf, sideDisplayLabel, whistleLabel } from "../marketMeta";

/**
 * LockedStrip — a market whose betting has closed. You can't bet it, so it collapses
 * to a thin status row (lane tag + question + when it resolves) below the live cards,
 * creating zero missed-bet pressure. Period markets read "until half-time" instead of
 * a fake timer.
 */
export function LockedStrip({
  market,
  now,
  betLabel,
}: {
  market: MarketVM;
  now: number;
  betLabel?: string;
}) {
  const lane = laneOf(market.kind, market.slot);
  const whistle = isWhistleBound(market.kind);
  const eventDecided = isEventDecided(market.kind, market.question);
  const left = Math.max(0, market.resolveAt - now);
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  const countdown = whistle
    ? whistleLabel(market.kind)
    : eventDecided
      ? eventDecidedLabel(market.kind)
      : mins > 0
        ? `${mins}:${String(secs).padStart(2, "0")}`
        : `${Math.ceil(left / 1000)}s`;

  return (
    <View style={[styles.strip, { borderLeftColor: lane.color }]}>
      <Text style={[styles.tag, { color: lane.color }]} numberOfLines={1}>
        {lane.label}
      </Text>
      <Text style={styles.q} numberOfLines={1}>
        {market.question}
      </Text>
      {betLabel ? (
        <Text style={styles.bet} numberOfLines={1}>
          {betLabel}
        </Text>
      ) : null}
      <Text style={styles.count} numberOfLines={1}>
        {countdown}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface0,
    borderLeftWidth: 2,
    borderRadius: 0,
    borderTopRightRadius: radius.sm,
    borderBottomRightRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  tag: {
    ...type.overline,
    fontSize: 9.5,
    letterSpacing: 0.5,
    minWidth: 54,
  },
  q: { ...type.body, fontSize: 13, color: colors.textSecondary, flex: 1 },
  bet: { ...type.caption, fontSize: 11.5, color: colors.textPrimary },
  count: { ...type.caption, fontSize: 11.5, color: colors.textMuted },
});
