// OWNED BY: home agent — ONE global points leaderboard (real + paper).
import React from "react";
import { StyleSheet, View } from "react-native";
import { useStore } from "@/state/store";
import { colors, spacing, type } from "@/theme";
import { Screen, Text } from "@/ui";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { PointsLeaderboard } from "@/features/points/PointsLeaderboard";
import { usePointsLeaderboardSync } from "@/features/points/usePointsLeaderboardSync";
import { usePointsIdentity } from "@/features/points/usePointsIdentity";
import { useAccount } from "@/features/auth/useAccount";
import { pts } from "@/lib/format";

export default function RankTab() {
  const store = useStore();
  const account = useAccount();
  const { userId: meId } = usePointsIdentity();
  // You only have a standing once you've created an account. While the account
  // system is live but you're signed out, the leaderboard is still public — you
  // just don't get a personal rank until you're in.
  const hasAccount = !(account.enabled && account.ready && !account.authenticated);

  usePointsLeaderboardSync(true);

  return (
    <Screen vignette="gold">
      <UnifiedHeader variant="screen" title="Rank" />

      <Text preset="caption" muted style={styles.sub}>
        One global leaderboard — you earn points on every bet, real or paper.
      </Text>

      {hasAccount ? (
        <View style={styles.youRow}>
          <Text style={styles.youLabel}>Your standing</Text>
          <Text style={styles.youRank}>#{store.pointsRank || "—"}</Text>
          <Text style={styles.youBal}>{pts(store.pointsBalance)}</Text>
        </View>
      ) : (
        <View style={styles.youRow}>
          <Text style={styles.youLabel}>Your standing</Text>
          <Text style={styles.youHint}>Sign in to claim a rank</Text>
        </View>
      )}

      <PointsLeaderboard players={store.pointsLeaderboard} meId={hasAccount ? meId : undefined} />
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
  youHint: { ...type.caption, color: colors.gold },
});
