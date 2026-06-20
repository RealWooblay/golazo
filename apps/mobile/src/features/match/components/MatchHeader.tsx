import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, fontFamily, spacing, type } from "@/theme";
import { AnimatedNumber, Chip, IconButton, IconBack, Text } from "@/ui";
import { money } from "@/lib/format";

/**
 * MatchHeader — the compact top bar of the live match screen: a back chevron, the
 * GOLAZO wordmark, a mode chip, and a live count-up balance pill on the right.
 * Pinned above the safe area so the scoreboard sits right beneath it.
 *
 * The balance uses AnimatedNumber so a win visibly counts the balance UP the
 * instant a reveal pays out (the brief's "balance count-up").
 */
export function MatchHeader({
  balance,
  format = money,
  balanceLabel = "balance",
  live,
  playMode = false,
  onBack,
  onHelp,
}: {
  balance: number;
  format?: (n: number) => string;
  balanceLabel?: string;
  live: boolean;
  playMode?: boolean;
  onBack?: () => void;
  onHelp?: () => void;
}) {
  return (
    <View style={styles.bar}>
      <IconButton accessibilityLabel="Back" onPress={onBack} size={38}>
        <IconBack size={20} color={colors.textPrimary} />
      </IconButton>

      <View style={styles.center}>
        <Text style={styles.brand} accessibilityRole="header">
          GOLAZO
        </Text>
        <Chip
          label={playMode ? "PAPER TRADE" : live ? "LIVE FEED" : "SANDBOX"}
          tone={playMode ? "win" : live ? "live" : "info"}
          dot
          onPress={onHelp}
          style={styles.modeChip}
        />
      </View>

      <View style={styles.balance}>
        <AnimatedNumber
          value={balance}
          format={format}
          style={styles.balValue}
        />
        <Text style={styles.balLabel}>{balanceLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  center: { alignItems: "center", gap: 5 },
  brand: {
    fontFamily: fontFamily.display,
    fontWeight: "700",
    fontSize: 18,
    letterSpacing: 1,
    color: colors.primary,
  },
  modeChip: { paddingVertical: 3, paddingHorizontal: spacing.sm },
  balance: { alignItems: "flex-end", minWidth: 64 },
  balValue: { ...type.mono, fontSize: 17, color: colors.textPrimary },
  balLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    marginTop: 1,
  },
});
