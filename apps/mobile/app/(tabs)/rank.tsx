// OWNED BY: home agent — ONE global points leaderboard (real + paper).
import React from "react";
import { StyleSheet, View } from "react-native";
import { useStore } from "@/state/store";
import { colors, radius, spacing, type } from "@/theme";
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

  const isLeading = hasAccount && store.pointsRank === 1;

  return (
    <Screen>
      <UnifiedHeader variant="screen" title="Rank" />

      {hasAccount ? (
        <View style={styles.standing}>
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>RANK</Text>
            <Text style={styles.statValue}>#{store.pointsRank || "—"}</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>POINTS</Text>
            <Text style={styles.statValue}>{pts(store.pointsBalance)}</Text>
          </View>
          {isLeading ? (
            <View style={styles.laneChip}>
              <Text style={styles.laneChipText}>LEADING</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.standing}>
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>RANK</Text>
            <Text style={styles.statHint}>Sign in to claim a rank</Text>
          </View>
        </View>
      )}

      <PointsLeaderboard
        players={store.pointsLeaderboard}
        meId={hasAccount ? meId : undefined}
        compact={false}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Flat "your standing" card: stat cells + an optional LEADING lane chip.
  standing: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xl,
    marginBottom: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  statCell: { gap: 2 },
  statLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.4,
  },
  statValue: { ...type.display, fontSize: 22, color: colors.textPrimary },
  statHint: { ...type.mono, fontSize: 14, color: colors.textMuted },

  // Green LEADING lane chip — the card's only colour splash (accent @14%).
  laneChip: {
    marginLeft: "auto",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.alpha.yes,
  },
  laneChipText: {
    ...type.overline,
    fontSize: 10,
    color: colors.yes,
    letterSpacing: 1.2,
  },
});
