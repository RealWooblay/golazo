import React from "react";
import { StyleSheet, View } from "react-native";
import type { PointsPlayer } from "@golazo/core";
import { POINTS_START_BALANCE } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { AnimatedNumber, Chip, Surface, Text } from "@/ui";
import { pts } from "@/lib/format";

/**
 * ONE global points leaderboard — everyone, real + paper. Same visual language
 * as friends room standings. Points move on every bet, so it's always live.
 */
export function PointsLeaderboard({
  players,
  meId,
  compact = false,
}: {
  players: PointsPlayer[];
  meId?: string;
  compact?: boolean;
}) {
  const top = players[0]?.balance ?? 0;
  const second = players[1]?.balance ?? top;
  const hasLeader = players.length > 1 && top > second;

  if (players.length === 0) {
    return (
      <Surface radius={radius.lg} style={styles.empty}>
        <Text style={styles.emptyTitle}>No players yet</Text>
        <Text style={styles.emptySub}>
          Place a bet on a live match to get on the board — everyone starts at{" "}
          {pts(POINTS_START_BALANCE)}.
        </Text>
      </Surface>
    );
  }

  return (
    <View style={styles.wrap}>
      {players.map((p, i) => {
        const isLeader = hasLeader && i === 0;
        const isMe = !!meId && p.userId === meId;
        return (
          <Surface
            key={p.userId}
            radius={radius.lg}
            glow={isLeader ? "gold" : undefined}
            borderColor={isLeader ? colors.glow.goldSoft : undefined}
            style={StyleSheet.flatten([
              styles.row,
              compact ? styles.rowCompact : undefined,
            ])}
          >
            <View style={styles.rank}>
              <Text
                style={[styles.rankNum, isLeader && styles.rankNumLead]}
                allowFontScaling={false}
              >
                {i + 1}
              </Text>
            </View>
            <View style={styles.who}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>
                  {p.name || "Player"}
                </Text>
                {isMe ? <Chip label="YOU" tone="info" /> : null}
                {!p.connected ? <Chip label="AWAY" tone="neutral" /> : null}
              </View>
              {isLeader ? (
                <Text style={styles.leadCaption}>
                  {pts(top - second)} ahead
                </Text>
              ) : (
                <Text style={styles.sub}>Live session</Text>
              )}
            </View>
            <View style={styles.points}>
              <AnimatedNumber
                value={p.balance}
                format={pts}
                style={StyleSheet.flatten([
                  styles.ptsValue,
                  isLeader ? styles.ptsValueLead : undefined,
                ])}
              />
              <Text style={styles.ptsLabel}>POINTS</Text>
            </View>
          </Surface>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  empty: { padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { ...type.subtitle, color: colors.textPrimary },
  emptySub: { ...type.caption, color: colors.textMuted, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowCompact: { paddingVertical: spacing.sm },
  rank: { width: 22, alignItems: "center" },
  rankNum: { ...type.display, fontSize: 20, color: colors.textGhost },
  rankNumLead: { color: colors.gold },
  who: { flex: 1, gap: 2 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: {
    ...type.subtitle,
    fontSize: 16,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  sub: { ...type.caption, fontSize: 11, color: colors.textFaint },
  leadCaption: { ...type.caption, fontSize: 11, color: colors.gold },
  points: { alignItems: "flex-end", minWidth: 72 },
  ptsValue: { ...type.mono, fontSize: 18, color: colors.textPrimary },
  ptsValueLead: { color: colors.gold },
  ptsLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.4,
    marginTop: 1,
  },
});
