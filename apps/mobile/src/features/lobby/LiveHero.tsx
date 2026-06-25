import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, gradients, radius, spacing, type } from "@/theme";
import { Crest } from "./Crest";
import {
  Entrance,
  GradientFill,
  PressableScale,
  PulseDot,
  StatusChip,
} from "../_shared/primitives";
import type { Fixture } from "./fixtures";

/**
 * LiveHero — the "now playing" centrepiece at the top of the Lobby. A big,
 * cinematic card: vignette glow, both crests flanking a huge tabular scoreline,
 * a live status chip with a pulse, the hot in-play moment, and a glowing
 * "Bet the play" call-to-action. Tapping anywhere opens the match.
 */
export function LiveHero({
  fixture,
  hapticsEnabled,
  onPress,
}: {
  fixture: Fixture;
  hapticsEnabled: boolean;
  onPress: () => void;
}) {
  return (
    <Entrance>
      <PressableScale
        depth="subtle"
        haptic="select"
        hapticsEnabled={hapticsEnabled}
        onPress={onPress}
        style={styles.card}
      >
        {/* crisp 1px top edge — clean depth, no muddy wash */}
        <View pointerEvents="none" style={styles.topHighlight} />

        <View style={styles.headerRow}>
          <StatusChip label={`LIVE · ${fixture.clock}`} tone="live" pulse />
          <Text style={styles.league}>{fixture.league}</Text>
        </View>

        <View style={styles.scoreRow}>
          <View style={styles.side}>
            <Crest team={fixture.home} size={56} />
            <Text style={styles.teamAbbr}>{fixture.home.abbr}</Text>
          </View>

          <View style={styles.center}>
            <Text style={styles.score} allowFontScaling={false}>
              {fixture.scoreHome} <Text style={styles.colon}>:</Text>{" "}
              {fixture.scoreAway}
            </Text>
            <View style={styles.clockRow}>
              <PulseDot color={colors.no} size={6} />
              <Text style={styles.clock}>{fixture.clock}</Text>
            </View>
          </View>

          <View style={styles.side}>
            <Crest team={fixture.away} size={56} />
            <Text style={styles.teamAbbr}>{fixture.away.abbr}</Text>
          </View>
        </View>

        {fixture.hotMoment ? (
          <View style={styles.momentWrap}>
            <Text style={styles.momentLabel}>HOT MOMENT</Text>
            <Text style={styles.moment} numberOfLines={2}>
              {fixture.hotMoment}
            </Text>
          </View>
        ) : null}

        <View style={styles.cta}>
          <GradientFill
            colors={gradients.yes}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          <View style={styles.ctaSide} />
          <Text style={styles.ctaText}>Bet the play</Text>
          <View style={[styles.ctaSide, styles.ctaSideRight]}>
            <View style={styles.ctaMeta}>
              <Text style={styles.ctaMetaText}>
                {fixture.liveMarkets} live markets
              </Text>
            </View>
          </View>
        </View>
      </PressableScale>
    </Entrance>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    // confident live accent border + a crisp (not muddy) green energy glow
    borderColor: "rgba(39,224,138,0.55)",
    backgroundColor: colors.surface1,
    overflow: "hidden",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    shadowColor: colors.yes,
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  league: {
    ...type.caption,
    color: colors.textMuted,
    flexShrink: 1,
    textAlign: "right",
    marginLeft: spacing.sm,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  side: { alignItems: "center", gap: spacing.sm, width: 72 },
  teamAbbr: { ...type.subtitle, color: colors.textPrimary, fontSize: 15 },
  center: { alignItems: "center", flex: 1 },
  score: {
    ...type.hero,
    color: colors.textPrimary,
    fontSize: 52,
    letterSpacing: 1,
  },
  colon: { color: colors.textFaint },
  clockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  clock: { ...type.overline, color: colors.no, fontSize: 11 },
  momentWrap: {
    marginTop: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: colors.alpha.white06,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: 4,
  },
  momentLabel: { ...type.overline, color: colors.yes, fontSize: 9 },
  moment: { ...type.bodyStrong, color: colors.textPrimary, fontSize: 16 },
  cta: {
    marginTop: spacing.lg,
    height: 52,
    borderRadius: radius.md,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  // equal-width flex sides keep the centred label centred while the meta chip
  // stays an in-flow sibling on the right — so the two can never overlap.
  ctaSide: { flex: 1 },
  ctaSideRight: { alignItems: "flex-end" },
  ctaText: { ...type.subtitle, color: colors.onYes, fontSize: 17 },
  ctaMeta: {
    backgroundColor: "rgba(4,17,11,0.18)",
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  ctaMetaText: {
    ...type.overline,
    color: colors.onYes,
    fontSize: 9,
    opacity: 0.85,
  },
});
