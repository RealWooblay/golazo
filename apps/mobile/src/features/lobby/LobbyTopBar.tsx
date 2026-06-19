import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontFamily, radius, spacing, type } from "@/theme";
import { money } from "@/lib/format";
import { CountUp, PressableScale } from "../_shared/primitives";

/**
 * LobbyTopBar — the sticky top bar on the Play tab: the GOLAZO wordmark on the
 * left, and on the right a balance block (animated count-up) plus a glowing
 * "+ Add cash" pill. Tapping the balance opens the same add-cash flow.
 */
export function LobbyTopBar({
  balance,
  format = money,
  hapticsEnabled,
  onAddCash,
  onOpenProfile,
}: {
  balance: number;
  /** Formatter for the balance — SOL in chain mode, $ in sandbox. */
  format?: (n: number) => string;
  hapticsEnabled: boolean;
  onAddCash: () => void;
  onOpenProfile: () => void;
}) {
  return (
    <View style={styles.bar}>
      <PressableScale
        haptic="tap"
        hapticsEnabled={hapticsEnabled}
        onPress={onOpenProfile}
        hitSlop={6}
      >
        <View style={styles.brandRow}>
          <Text style={styles.bolt}></Text>
          <Text style={styles.brand}>GOLAZO</Text>
        </View>
      </PressableScale>

      <View style={styles.right}>
        <PressableScale
          haptic="tap"
          hapticsEnabled={hapticsEnabled}
          onPress={onAddCash}
          hitSlop={4}
        >
          <View style={styles.balBlock}>
            <CountUp value={balance} format={format} style={styles.balValue} />
            <Text style={styles.balLabel}>balance</Text>
          </View>
        </PressableScale>
        <PressableScale
          haptic="select"
          hapticsEnabled={hapticsEnabled}
          onPress={onAddCash}
        >
          <View style={styles.addBtn}>
            <Text style={styles.addText}>+ Add cash</Text>
          </View>
        </PressableScale>
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
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  bolt: { fontSize: 18 },
  brand: {
    fontFamily: fontFamily.display,
    color: colors.yes,
    fontWeight: "900",
    fontSize: 22,
    letterSpacing: 0.5,
  },
  right: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  balBlock: { alignItems: "flex-end" },
  balValue: { ...type.mono, color: colors.textPrimary, fontSize: 20 },
  balLabel: { ...type.overline, color: colors.textMuted, fontSize: 9 },
  addBtn: {
    backgroundColor: colors.alpha.cyan,
    borderWidth: 1,
    borderColor: "rgba(22,198,255,0.45)",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  addText: { ...type.bodyStrong, color: colors.cyan, fontSize: 13 },
});
