import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Overline, Surface, Text } from "@/ui";
import { Crest } from "@/features/lobby/Crest";
import type { FixtureTeam } from "@/features/lobby/fixtures";

/**
 * LiveScoreboard — flat, minimal, exchange-clean. Both crests flank a big tabular
 * scoreline, a quiet status overline (clock + LIVE), and a single thin momentum bar
 * (home-blue vs away-orange — A-vs-B, no glow, no animation). No cinematic depth, no
 * goal flashes — the redesign language: numbers lead, decoration gone.
 */
export function LiveScoreboard({
  home,
  away,
  scoreHome,
  scoreAway,
  clock,
  /** 'home' | 'away' = who's attacking; undefined = even / nothing live. */
  momentum,
  /** Continuous lean in [0..1] (0 = home pressing, 1 = away pressing). */
  momentumLean,
  live = true,
}: {
  home: FixtureTeam;
  away: FixtureTeam;
  scoreHome: number;
  scoreAway: number;
  clock: string;
  momentum?: "home" | "away";
  momentumLean?: number | null;
  live?: boolean;
}) {
  // Home share of the bar (left). The feed's lean is the AWAY share, so invert.
  const homeShare =
    typeof momentumLean === "number"
      ? Math.min(0.85, Math.max(0.15, 1 - momentumLean))
      : momentum === "home"
        ? 0.8
        : momentum === "away"
          ? 0.2
          : 0.5;

  return (
    <Surface flat radius={radius.lg} style={styles.card}>
      <View style={styles.scoreRow}>
        <View style={styles.side}>
          <Crest team={home} size={46} />
          <Text style={styles.abbr} numberOfLines={1}>
            {home.abbr}
          </Text>
        </View>

        <View style={styles.center}>
          <View style={styles.scoreLine}>
            <Text style={styles.score} allowFontScaling={false}>
              {scoreHome}
            </Text>
            <Text style={styles.colon}>:</Text>
            <Text style={styles.score} allowFontScaling={false}>
              {scoreAway}
            </Text>
          </View>
          <View style={styles.statusRow}>
            {live ? <View style={styles.liveDot} /> : null}
            <Overline size={9} color={live ? colors.no : colors.textMuted}>
              {live ? `${clock} · LIVE` : clock}
            </Overline>
          </View>
        </View>

        <View style={styles.side}>
          <Crest team={away} size={46} />
          <Text style={styles.abbr} numberOfLines={1}>
            {away.abbr}
          </Text>
        </View>
      </View>

      <View style={styles.momentum}>
        <View style={{ flex: homeShare, backgroundColor: colors.home }} />
        <View style={{ flex: 1 - homeShare, backgroundColor: colors.away }} />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, gap: spacing.lg },
  scoreRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  side: { alignItems: "center", gap: spacing.sm, width: 64 },
  abbr: { ...type.subtitle, fontSize: 13, letterSpacing: 0.6, color: colors.textSecondary },
  center: { flex: 1, alignItems: "center" },
  scoreLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  score: { ...type.display, fontSize: 50, lineHeight: 54, color: colors.textPrimary },
  colon: { ...type.display, fontSize: 38, color: colors.textGhost },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.no },
  momentum: {
    flexDirection: "row",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: colors.surface2,
  },
});
