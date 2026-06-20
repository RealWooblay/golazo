// OWNED BY: home agent — ONE global points leaderboard (real + paper).
import React from "react";
import { StyleSheet, View } from "react-native";
import { useStore } from "@/state/store";
import { colors, spacing, type } from "@/theme";
import { Screen, Text } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { PointsLeaderboard } from "@/features/points/PointsLeaderboard";
import { usePointsLeaderboardSync } from "@/features/points/usePointsLeaderboardSync";
import { USER_ID } from "@/lib/config";
import { pts } from "@/lib/format";

export default function RankTab() {
  const store = useStore();
  const playMode = store.session.moneyMode === "points";
  const meId = playMode ? store.session.pointsUserId : USER_ID;

  usePointsLeaderboardSync(true);

  return (
    <Screen vignette="gold">
      <UnifiedHeader variant="screen" title="Rank" />

      <Text preset="caption" muted style={styles.sub}>
        One global leaderboard — you earn points on every bet, real or paper.
      </Text>

      <View style={styles.youRow}>
        <Text style={styles.youLabel}>Your standing</Text>
        <Text style={styles.youRank}>#{store.pointsRank || "—"}</Text>
        <Text style={styles.youBal}>{pts(store.pointsBalance)}</Text>
      </View>

      <PointsLeaderboard players={store.pointsLeaderboard} meId={meId} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: { lineHeight: 18, marginBottom: spacing.md },
  youRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.alpha.gold,
    borderWidth: 1,
    borderColor: colors.glow.goldSoft,
  },
  youLabel: { ...type.caption, color: colors.textMuted, flex: 1 },
  youRank: { ...type.mono, fontSize: 18, color: colors.gold },
  youBal: { ...type.mono, fontSize: 16, color: colors.textPrimary },
});
