import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import { Text } from "@/ui";
import {
  CountUp,
  Entrance,
  PressableScale,
  Vignette,
} from "../_shared/primitives";
import { streakLabel, winRatePct, type LifetimeStats } from "./stats";

/**
 * ProfileHero — the identity + record block at the top of Profile. A gradient
 * initials avatar, the display name (tap to edit), a member-since-style subline,
 * and a 4-up tile grid of lifetime stats derived from the ledger. Net P/L is the
 * headline number and colors green/red. Everything reads big and confident.
 */
export function ProfileHero({
  name,
  balance,
  balanceFormat,
  balanceLabel = "Balance",
  signedFormat,
  stats,
  onEditName,
}: {
  name: string;
  balance: number;
  /** Formatter for the balance — pts in paper mode, $/USX otherwise. */
  balanceFormat?: (n: number) => string;
  balanceLabel?: string;
  signedFormat?: (n: number) => string;
  stats: LifetimeStats;
  onEditName: () => void;
}) {
  const currency = useDisplayBalance();
  const display = name?.trim() || "Player";
  const netPositive = stats.net >= 0;
  const formatAmount = balanceFormat ?? currency.format;
  const formatSigned = signedFormat ?? currency.signedFormat;

  return (
    <Entrance>
      <View style={styles.card}>
        <Vignette color={colors.gold} opacity={0.1} cx="20%" cy="0%" />
        <View pointerEvents="none" style={styles.topHighlight} />

        <View style={styles.identity}>
          <View style={styles.nameBlock}>
            <PressableScale
              haptic="tap"
              onPress={onEditName}
              hitSlop={6}
              style={styles.nameRow}
            >
              <Text preset="title" numberOfLines={1} style={styles.name}>
                {display}
              </Text>
              <View style={styles.editPill}>
                <Text style={styles.editText}>edit</Text>
              </View>
            </PressableScale>
            <View style={styles.balanceRow}>
              <Text preset="caption" muted>
                {balanceLabel}
              </Text>
              <CountUp
                value={balance}
                format={formatAmount}
                style={styles.balance}
              />
            </View>
          </View>
        </View>

        <View style={styles.grid}>
          <StatTile
            label="Net P/L"
            value={formatSigned(stats.net)}
            tone={netPositive ? "yes" : "no"}
            big
          />
          <StatTile label="Win rate" value={winRatePct(stats)} tone="cyan" />
          <StatTile
            label="Wagered"
            value={formatAmount(stats.wagered)}
            tone="neutral"
          />
          <StatTile
            label="Biggest win"
            value={stats.biggestWin > 0 ? formatSigned(stats.biggestWin) : "—"}
            tone="gold"
          />
          <StatTile
            label="Bets"
            value={String(stats.totalBets)}
            tone="neutral"
          />
          <StatTile
            label="Streak"
            value={streakLabel(stats.streak)}
            tone={
              stats.streak > 0 ? "yes" : stats.streak < 0 ? "no" : "neutral"
            }
          />
        </View>
      </View>
    </Entrance>
  );
}

function StatTile({
  label,
  value,
  tone,
  big,
}: {
  label: string;
  value: string;
  tone: "yes" | "no" | "cyan" | "gold" | "neutral";
  big?: boolean;
}) {
  const color =
    tone === "yes"
      ? colors.yes
      : tone === "no"
        ? colors.no
        : tone === "cyan"
          ? colors.cyan
          : tone === "gold"
            ? colors.gold
            : colors.textPrimary;
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text
        style={[styles.tileValue, { color, fontSize: big ? 22 : 18 }]}
        allowFontScaling={false}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface1,
    overflow: "hidden",
    padding: spacing.lg,
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
  identity: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  avatarWrap: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.alpha.white10,
  },
  initials: {
    ...type.display,
    color: "#04110b",
    fontSize: 24,
    textShadowColor: "rgba(255,255,255,0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  nameBlock: { flex: 1, gap: 4 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { color: colors.textPrimary, flexShrink: 1 },
  editPill: {
    backgroundColor: colors.alpha.white06,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  editText: { ...type.overline, color: colors.textMuted, fontSize: 8 },
  balanceRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  balance: { ...type.mono, color: colors.yes, fontSize: 16 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  tile: {
    width: "31.5%",
    flexGrow: 1,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: 4,
  },
  tileLabel: { ...type.overline, color: colors.textFaint, fontSize: 8 },
  tileValue: { ...type.display },
});
