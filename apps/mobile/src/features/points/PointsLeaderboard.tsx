import React from "react";
import { StyleSheet, View } from "react-native";
import type { PointsPlayer } from "@golazo/core";
import { POINTS_START_BALANCE } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { AnimatedNumber, Text } from "@/ui";
import { pts } from "@/lib/format";

/**
 * ONE global points leaderboard — everyone, real + paper. FLAT design language:
 * each entry is a flat row (surface1 fill + hairline, no gradient/glow), a fixed
 * rank number, the player name (+ a cyan YOU badge if it's you), and the points
 * right-aligned. No leader glow, no per-rank colouring — accent stays surgical.
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
  if (players.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No players yet</Text>
        <Text style={styles.emptySub}>
          Place a bet to get on the board. Everyone starts at{" "}
          {pts(POINTS_START_BALANCE)}.
        </Text>
      </View>
    );
  }

  // Podium-first: show ONLY the top 3 (gold/silver/bronze), then — if you're not up
  // there — a divider and just YOUR row with your real rank. Everyone between 3rd and
  // you, and everyone below you, is skipped. Tight + aspirational, not an endless list.
  const top3 = players.slice(0, 3);
  const meIdx = meId ? players.findIndex((p) => p.userId === meId) : -1;
  const showMeRow = meIdx >= 3; // you exist on the board but below the podium

  const renderRow = (p: PointsPlayer, rank: number) => {
    const isMe = !!meId && p.userId === meId;
    const medal = MEDAL[rank - 1]; // gold/silver/bronze for ranks 1-3, undefined otherwise
    return (
      <View
        key={p.userId}
        style={StyleSheet.flatten([
          styles.row,
          compact ? styles.rowCompact : undefined,
          medal ? { borderColor: medal + "66" } : undefined,
          isMe ? styles.rowMe : undefined,
        ])}
      >
        <Text
          style={StyleSheet.flatten([styles.rankNum, medal ? { color: medal } : undefined])}
          allowFontScaling={false}
        >
          {rank <= 3 ? rank : `#${rank}`}
        </Text>

        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>
            {p.name || "Player"}
          </Text>
          {isMe ? (
            <View style={styles.youBadge}>
              <Text style={styles.youBadgeText}>YOU</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.points}>
          <AnimatedNumber value={p.balance} format={pts} style={styles.ptsValue} />
          <Text style={styles.ptsLabel}>PTS</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      {top3.map((p, i) => renderRow(p, i + 1))}
      {showMeRow ? (
        <>
          <Text style={styles.divider}>· · ·</Text>
          {renderRow(players[meIdx]!, meIdx + 1)}
        </>
      ) : null}
    </View>
  );
}

/** Gold / silver / bronze for the podium (ranks 1-3). */
const MEDAL = ["#FFD23F", "#C8D0DA", "#CD7F32"] as const;

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },

  // ── Empty state (flat card) ──
  empty: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { ...type.subtitle, color: colors.textPrimary },
  emptySub: { ...type.caption, color: colors.textMuted, lineHeight: 18 },

  // ── Leaderboard row (flat) ──
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowCompact: { paddingVertical: spacing.sm },
  rowMe: { borderColor: colors.glow.cyanSoft, backgroundColor: colors.alpha.cyan },
  divider: {
    ...type.mono,
    fontSize: 14,
    color: colors.textFaint,
    textAlign: "center",
    letterSpacing: 4,
    paddingVertical: 2,
  },

  rankNum: {
    ...type.mono,
    fontSize: 18,
    color: colors.textFaint,
    width: 22,
    textAlign: "center",
  },

  who: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  name: {
    ...type.subtitle,
    fontSize: 16,
    color: colors.textPrimary,
    flexShrink: 1,
  },

  // cyan "YOU" outcome pill
  youBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.alpha.cyan,
    borderWidth: 1,
    borderColor: colors.glow.cyanSoft,
  },
  youBadgeText: {
    ...type.overline,
    fontSize: 9,
    color: colors.cyan,
    letterSpacing: 1.2,
  },

  points: { alignItems: "flex-end", minWidth: 72 },
  ptsValue: { ...type.mono, fontSize: 18, color: colors.textPrimary },
  ptsLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.4,
    marginTop: 1,
  },
});
