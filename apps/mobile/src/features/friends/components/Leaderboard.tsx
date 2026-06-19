import React from "react";
import { StyleSheet, View } from "react-native";
import type { RoomPlayer } from "@golazo/core";
import { ROOM_START_BALANCE } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { AnimatedNumber, Chip, Surface, Text } from "@/ui";
import { money } from "@/lib/format";

/**
 * Leaderboard — the room standings. Each player in a row, ordered
 * leader-first (the parent passes `players` already sorted balance-desc from the
 * hook). The leader gets a gold "LEADING" chip + a faint gold edge; "you" is
 * always tagged so a player can find themselves at a glance.
 *
 * Balances ($) are AUTHORITATIVE from the server's RoomState — we only render them
 * (with a spring count-up via AnimatedNumber so a settled bet visibly nudges the
 * tab). A solo room (waiting for a friend) still renders cleanly: one row + a
 * ghost slot.
 */
export function Leaderboard({
  players,
  meId,
  compact = false,
}: {
  players: RoomPlayer[];
  /** The local player's userId — to tag "you". */
  meId: string;
  /** Tighter padding for the full-time panel. */
  compact?: boolean;
}) {
  // A clear leader only when someone is actually ahead (no gold tie / level lead).
  const top = players[0]?.balance ?? 0;
  const second = players[1]?.balance ?? top;
  const hasLeader = players.length > 1 && top > second;

  return (
    <View style={styles.wrap}>
      {players.map((p, i) => {
        const isLeader = hasLeader && i === 0;
        const isMe = p.userId === meId;
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
                  {money(top - second)} ahead
                </Text>
              ) : (
                <Text style={styles.sub} numberOfLines={1}>
                  {p.isHost ? "Host" : "Challenger"}
                </Text>
              )}
            </View>

            <View style={styles.points}>
              <AnimatedNumber
                value={p.balance}
                format={money}
                style={StyleSheet.flatten([
                  styles.ptsValue,
                  isLeader ? styles.ptsValueLead : undefined,
                ])}
              />
              <Text style={styles.ptsLabel}>BALANCE</Text>
            </View>
          </Surface>
        );
      })}

      {players.length < 2 ? (
        <View style={[styles.ghostRow, compact && styles.rowCompact]}>
          <View style={styles.rank}>
            <Text style={styles.rankNum} faint allowFontScaling={false}>
              2
            </Text>
          </View>
          <View style={styles.who}>
            <Text style={styles.ghostName}>Waiting for friends…</Text>
            <Text style={styles.sub}>starts at {money(ROOM_START_BALANCE)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
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
  points: { alignItems: "flex-end", minWidth: 64 },
  ptsValue: { ...type.mono, fontSize: 20, color: colors.textPrimary },
  ptsValueLead: { color: colors.gold },
  ptsLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.4,
    marginTop: 1,
  },
  ghostRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.hairline,
    backgroundColor: colors.alpha.white06,
  },
  ghostName: { ...type.subtitle, fontSize: 15, color: colors.textMuted },
});
