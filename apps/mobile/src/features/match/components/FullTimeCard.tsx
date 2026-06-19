// FULL TIME — the game's end state on the match screen. When the live game
// reaches `status: 'final'` there are no more markets, so instead of leaving the
// stage on the "reading the game" radar forever, we close the session cleanly:
// the final score with both crests, who won, a "bets settled" note, and a way
// back to the lobby. (Friends rooms have their own full-time standings screen;
// this is the equivalent end state for a solo/live game.)
import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Surface, Text } from "@/ui";
import { Crest } from "@/features/lobby/Crest";
import type { FixtureTeam } from "@/features/lobby/fixtures";
import { GlowWash } from "./GlowWash";

export function FullTimeCard({
  home,
  away,
  scoreHome,
  scoreAway,
  onExit,
}: {
  home: FixtureTeam;
  away: FixtureTeam;
  scoreHome: number;
  scoreAway: number;
  onExit: () => void;
}) {
  const result =
    scoreHome > scoreAway
      ? `${home.name} win`
      : scoreAway > scoreHome
        ? `${away.name} win`
        : "Honours even — a draw";

  return (
    <Surface radius={radius.xl} style={styles.card}>
      <GlowWash
        color={colors.raw.surface3}
        opacity={0.7}
        cx="50%"
        cy="28%"
        r="65%"
      />

      <Text style={styles.eyebrow}>FULL TIME</Text>

      <View style={styles.scoreRow}>
        <View style={styles.side}>
          <Crest team={home} size={52} />
          <Text style={styles.abbr} numberOfLines={1}>
            {home.abbr}
          </Text>
        </View>

        <View style={styles.center}>
          <Text style={styles.score} allowFontScaling={false}>
            {scoreHome} <Text style={styles.colon}>:</Text> {scoreAway}
          </Text>
        </View>

        <View style={styles.side}>
          <Crest team={away} size={52} />
          <Text style={styles.abbr} numberOfLines={1}>
            {away.abbr}
          </Text>
        </View>
      </View>

      <Text style={styles.result} center>
        {result}
      </Text>
      <Text style={styles.settled} center>
        Bets are settled — your results are in your history.
      </Text>

      <Button
        label="Back to the lobby"
        onPress={onExit}
        variant="primary"
        fullWidth
        glow
        style={styles.cta}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    alignItems: "center",
    overflow: "hidden",
  },
  eyebrow: {
    ...type.overline,
    fontSize: 11,
    color: colors.gold,
    letterSpacing: 2,
    marginBottom: spacing.lg,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "stretch",
  },
  side: { alignItems: "center", gap: 7, width: 72 },
  abbr: {
    ...type.subtitle,
    fontSize: 13,
    color: colors.textSecondary,
    letterSpacing: 0.6,
  },
  center: { flex: 1, alignItems: "center" },
  score: {
    ...type.hero,
    fontSize: 48,
    color: colors.textPrimary,
    letterSpacing: 1,
  },
  colon: { color: colors.textGhost },
  result: {
    ...type.subtitle,
    fontSize: 17,
    color: colors.textPrimary,
    marginTop: spacing.lg,
  },
  settled: {
    ...type.caption,
    fontSize: 12.5,
    color: colors.textMuted,
    marginTop: 4,
    maxWidth: 280,
  },
  cta: { marginTop: spacing.lg, alignSelf: "stretch" },
});
