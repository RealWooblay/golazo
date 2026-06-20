// OWNED BY: home agent — ONE global points leaderboard (real + paper).
import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "@/state/store";
import { colors, MAX_WIDTH, spacing, type } from "@/theme";
import { GrainOverlay, Text, Vignette } from "@/ui";
import { MoneyModePicker } from "@/features/lobby/MoneyModePicker";
import { PointsLeaderboard } from "@/features/points/PointsLeaderboard";
import { usePointsLeaderboardSync } from "@/features/points/usePointsLeaderboardSync";
import { USER_ID } from "@/lib/config";
import { pts } from "@/lib/format";

export default function RankTab() {
  const store = useStore();
  const insets = useSafeAreaInsets();
  const hx = store.session.hapticsOn;
  // ONE global score. Points move on EVERY bet (real + paper, win AND lose), so
  // the leaderboard is always live and your standing shows in both modes. The
  // points identity is pointsUserId in paper mode and the engine USER_ID in real
  // mode — same as the bet that earns the points — so "YOU" matches either way.
  const playMode = store.session.moneyMode === "points";
  const meId = playMode ? store.session.pointsUserId : USER_ID;

  usePointsLeaderboardSync(true);

  return (
    <View style={styles.root}>
      <Vignette tint="gold" intensity={0.35} />
      <GrainOverlay />

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.lg, paddingBottom: 110 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          <Text style={styles.title}>Rankings</Text>
          <Text style={styles.sub}>
            One global leaderboard. You earn points on every bet — real or paper,
            win or lose.
          </Text>

          <MoneyModePicker
            value={store.session.moneyMode}
            onChange={store.setMoneyMode}
            hapticsEnabled={hx}
          />

          <View style={styles.youRow}>
            <Text style={styles.youLabel}>Your standing</Text>
            <Text style={styles.youRank}>#{store.pointsRank || "—"}</Text>
            <Text style={styles.youBal}>{pts(store.pointsBalance)}</Text>
          </View>

          <PointsLeaderboard players={store.pointsLeaderboard} meId={meId} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { alignItems: "center" },
  column: { width: "100%", maxWidth: MAX_WIDTH, gap: spacing.md },
  title: {
    ...type.display,
    fontSize: 28,
    color: colors.gold,
    paddingHorizontal: spacing.lg,
  },
  sub: {
    ...type.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  youRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
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
