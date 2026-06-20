import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Pressable, Text } from "@/ui";
import type { MoneyMode } from "@/state/types";

/**
 * MoneyModePicker — Real vs Paper. Both feed the ONE global points leaderboard
 * (you earn points on every bet either way); real mode also stakes SOL/play-$
 * against the main book, paper mode is fake points only.
 */
export function MoneyModePicker({
  value,
  onChange,
  hapticsEnabled,
}: {
  value: MoneyMode;
  onChange: (mode: MoneyMode) => void;
  hapticsEnabled: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <Pressable
        haptic="select"
        enabledHaptics={hapticsEnabled}
        onPress={() => onChange("real")}
        style={[styles.seg, value === "real" && styles.segOnReal]}
      >
        <Text style={[styles.segLabel, value === "real" && styles.segLabelOn]}>
          Real
        </Text>
        <Text style={styles.segSub}>Devnet SOL</Text>
      </Pressable>
      <Pressable
        haptic="select"
        enabledHaptics={hapticsEnabled}
        onPress={() => onChange("points")}
        style={[styles.seg, value === "points" && styles.segOnPlay]}
      >
        <Text style={[styles.segLabel, value === "points" && styles.segLabelOn]}>
          Paper
        </Text>
        <Text style={styles.segSub}>Live · fake points</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  seg: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    // Readable resting state — a real surface + clearer stroke, not a near-invisible
    // hairline/alpha wash, so an unselected mode still reads as a tappable target.
    borderColor: colors.surface3,
    backgroundColor: colors.surface2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    gap: 2,
  },
  segOnReal: {
    borderColor: colors.cyan,
    backgroundColor: colors.alpha.cyan,
  },
  segOnPlay: {
    borderColor: colors.gold,
    backgroundColor: colors.alpha.gold,
  },
  segLabel: {
    ...type.bodyStrong,
    fontSize: 14,
    color: colors.textSecondary,
  },
  segLabelOn: { color: colors.textPrimary },
  segSub: { ...type.caption, fontSize: 10, color: colors.textFaint },
});
