import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import type { ClosedMarketVM } from "@/state/types";

/**
 * Compact historic settled markets — one slim row each, outcome always visible.
 * The most recent live moment uses the big RevealCard instead (excluded upstream).
 */
export function ClosedMarketsList({
  markets,
  catchingUp = false,
}: {
  markets: ClosedMarketVM[];
  /** Fresh session load — label as catch-up history. */
  catchingUp?: boolean;
}) {
  const { format } = useDisplayBalance();
  if (markets.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>
        {catchingUp ? "EARLIER THIS MATCH" : "SESSION MARKETS"}
      </Text>
      <View style={styles.list}>
        {markets.map((m) => {
          const voided = m.outcome === "VOID";
          const yesWon = m.outcome === "YES";
          const tint = voided ? colors.cyan : yesWon ? colors.yes : colors.no;
          const label = voided ? "VOID" : yesWon ? "YES" : "NO";

          return (
            <View
              key={m.marketId}
              style={[styles.row, m.userSide ? styles.rowMine : null]}
            >
              <Text style={styles.question} numberOfLines={1}>
                {m.question}
              </Text>
              <View style={styles.meta}>
                <View style={[styles.badge, { backgroundColor: tint }]}>
                  <Text style={styles.badgeText}>{label}</Text>
                </View>
                <Text style={styles.pool}>{format(m.poolTotal)}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  header: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.2,
    paddingHorizontal: spacing.xs,
  },
  list: { gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowMine: { borderColor: colors.glow.yesSoft },
  question: {
    ...type.caption,
    flex: 1,
    fontSize: 11.5,
    color: colors.textMuted,
    lineHeight: 14,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    minWidth: 28,
    alignItems: "center",
  },
  badgeText: {
    ...type.overline,
    fontSize: 8,
    color: "#0a0b0f",
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  pool: {
    ...type.mono,
    fontSize: 10,
    color: colors.textFaint,
    minWidth: 36,
    textAlign: "right",
  },
});
