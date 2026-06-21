import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import type { BetRow } from "@/state/types";

/**
 * ResultsRail — a horizontal rail of your recent settled bets on this match,
 * newest first. Each pill shows the side, a W/L/V badge, and the signed delta in
 * its outcome color, so your run of form is glanceable under the live card. Hidden
 * entirely until you've settled at least one bet.
 */
export function ResultsRail({ bets }: { bets: BetRow[] }) {
  const { signedFormat } = useDisplayBalance();
  if (bets.length === 0) return null;
  const recent = bets.slice(0, 12);

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>YOUR RUN</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        {recent.map((b) => {
          const voided = b.outcome === "VOID";
          const tint = voided ? colors.cyan : b.won ? colors.gold : colors.no;
          const fill = voided
            ? colors.alpha.cyan
            : b.won
              ? colors.alpha.gold
              : colors.alpha.no;
          const badge = voided ? "V" : b.won ? "W" : "L";
          return (
            <View
              key={b.id}
              style={[
                styles.pill,
                { borderColor: tint, backgroundColor: fill },
              ]}
            >
              <View style={[styles.badge, { backgroundColor: tint }]}>
                <Text style={styles.badgeText}>{badge}</Text>
              </View>
              <View style={styles.pillBody}>
                <Text style={styles.pillSide}>{b.side}</Text>
                <Text
                  style={[
                    styles.pillDelta,
                    { color: voided ? colors.textMuted : tint },
                  ]}
                >
                  {voided ? "refund" : signedFormat(b.delta)}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  header: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.4,
    paddingHorizontal: spacing.xs,
  },
  rail: { gap: spacing.sm, paddingRight: spacing.lg },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  badge: {
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    ...type.overline,
    fontSize: 10,
    color: "#0a0b0f",
    fontWeight: "700",
  },
  pillBody: { gap: 1 },
  pillSide: {
    ...type.overline,
    fontSize: 9,
    color: colors.textSecondary,
    letterSpacing: 0.6,
  },
  pillDelta: { ...type.mono, fontSize: 12 },
});
