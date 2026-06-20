import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import type { FeedHealth, FeedMetrics } from "./useFeedOps";

type Props = {
  health: FeedHealth | null;
  metrics: FeedMetrics | null;
  error: string | null;
  onRefresh: () => void;
};

/**
 * FeedOpsPanel — a single, intentional status line for the live feed, tucked at
 * the bottom of Profile. Reads as a quiet health indicator, not a debug blob: a
 * status dot + label, with at most one metric ("{n} live"). The operational
 * jargon (watcher / play phase / poll age / lag / ai batch) is deliberately
 * dropped — that detail belongs in tooling, not the player's profile.
 *
 * State maps to one of three dot colours: live (healthy), reconnecting
 * (degraded), or down (unreachable). The whole row is a subtle tap-to-refresh.
 */
export function FeedOpsPanel({ health, metrics, error, onRefresh }: Props) {
  // Three states: down (no health at all), reconnecting (reachable but degraded),
  // and healthy. Pick the dot colour + label from that, nothing more.
  const down = !health;
  const healthy = !!health?.ok;

  const dot = down ? colors.no : healthy ? colors.yes : colors.gold;
  const label = down
    ? "Live feed · offline"
    : healthy
      ? "Live feed · healthy"
      : "Live feed · reconnecting";

  // One metric, and only when we actually have a feed: open markets.
  const metric =
    health && health.marketsOpen > 0 ? `${health.marketsOpen} live` : null;

  return (
    <Pressable
      onPress={onRefresh}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Tap to refresh.`}
    >
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {metric ? <Text style={styles.metric}>{metric}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: radius.pill },
  label: { ...type.caption, color: colors.textMuted },
  // Pushed to the far right; tabular so the count sits steady on refresh.
  metric: { ...type.mono, fontSize: 11, color: colors.textFaint, marginLeft: "auto" },
});
