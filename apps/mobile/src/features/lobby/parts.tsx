import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { Entrance, PressableScale, PulseDot } from "../_shared/primitives";
import { Crest } from "./Crest";
import { formatCountdown, type Fixture } from "./fixtures";

/**
 * LOBBY PARTS — small layout bits the Play screen needs that aren't worth their
 * own file: the section header (with a tone dot + caption), the "nothing live"
 * empty state, and the bottom how-it-works nudge. Re-exports Entrance so the
 * screen has one lobby import surface.
 */

export { Entrance };

/** A section header: title on the left, a tone-tinted caption chip on the right. */
export function SectionHeader({
  title,
  caption,
  tone = "live",
}: {
  title: string;
  caption?: string;
  tone?: "live" | "info" | "gold";
}) {
  const accent =
    tone === "live" ? colors.yes : tone === "gold" ? colors.gold : colors.cyan;
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        {tone === "live" ? (
          <PulseDot color={accent} size={7} />
        ) : (
          <View style={[styles.staticDot, { backgroundColor: accent }]} />
        )}
        <Text preset="subtitle">{title}</Text>
      </View>
      {caption ? (
        <Text
          style={[type.overline, { color: colors.textFaint, fontSize: 10 }]}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/** Shown when the slate has no live match — keeps the lobby warm, not empty. */
export function EmptyLobby({ onHowItWorks }: { onHowItWorks: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyGlyph}></Text>
      <Text preset="title" center>
        No match in play
      </Text>
      <Text preset="body" muted center style={styles.emptyBody}>
        The pitch is quiet right now. When kickoff hits, the next attack opens a
        market right here.
      </Text>
      <PressableScale
        haptic="tap"
        onPress={onHowItWorks}
        style={styles.emptyCta}
      >
        <Text preset="bodyStrong" color={colors.cyan}>
          See how it works
        </Text>
      </PressableScale>
    </View>
  );
}

/**
 * NextMatch — the "what's coming" card shown at the top of the lobby when nothing
 * is live. Replaces a dead empty box with a real next-game preview: both crests
 * (with country flags), team names, the league, and a live ticking countdown to
 * kickoff. Not tappable (you can't open a match before kickoff) — it's a teaser
 * with a how-it-works link.
 */
export function NextMatch({
  fixture,
  onHowItWorks,
}: {
  fixture: Fixture;
  onHowItWorks: () => void;
}) {
  return (
    <View style={styles.next}>
      <View pointerEvents="none" style={styles.nextTopHighlight} />
      <View style={styles.nextHead}>
        <View style={styles.titleRow}>
          <View style={[styles.staticDot, { backgroundColor: colors.cyan }]} />
          <Text style={styles.nextEyebrow}>UP NEXT</Text>
        </View>
        <Text style={styles.nextLeague} numberOfLines={1}>
          {fixture.league}
        </Text>
      </View>

      <View style={styles.nextMatchup}>
        <View style={styles.nextSide}>
          <Crest team={fixture.home} size={48} />
          <Text style={styles.nextTeam} numberOfLines={1}>
            {fixture.home.name}
          </Text>
        </View>

        <View style={styles.nextCenter}>
          <NextKickoff fixture={fixture} />
        </View>

        <View style={styles.nextSide}>
          <Crest team={fixture.away} size={48} />
          <Text style={styles.nextTeam} numberOfLines={1}>
            {fixture.away.name}
          </Text>
        </View>
      </View>

      <Text style={styles.nextHint} center>
        Markets open the second it kicks off.
      </Text>
      <PressableScale
        haptic="tap"
        onPress={onHowItWorks}
        style={styles.emptyCta}
      >
        <Text preset="bodyStrong" color={colors.cyan}>
          See how it works
        </Text>
      </PressableScale>
    </View>
  );
}

/** Live ticking "kicks off in" value — runtime wall clock, falls back to schedule. */
function NextKickoff({ fixture }: { fixture: Fixture }) {
  const hasKickoff = typeof fixture.kickoff === "number";
  const [label, setLabel] = useState(() => kickoffLabel(fixture));
  useEffect(() => {
    setLabel(kickoffLabel(fixture));
    if (!hasKickoff) return;
    const id = setInterval(() => setLabel(kickoffLabel(fixture)), 1000);
    return () => clearInterval(id);
  }, [fixture, hasKickoff]);
  return (
    <View style={styles.kickoff}>
      <Text style={styles.kickoffLabel}>KICKS OFF</Text>
      <Text style={styles.kickoffValue} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

function kickoffLabel(fixture: Fixture): string {
  if (typeof fixture.kickoff === "number") {
    const c = formatCountdown(fixture.kickoff - new Date().getTime());
    if (c) return c;
  }
  return fixture.clock || "Soon";
}

/** Bottom-of-feed prompt for newcomers — explains the mechanic without nagging. */
export function HowItWorksNudge({
  onPress,
  hapticsEnabled,
}: {
  onPress: () => void;
  hapticsEnabled: boolean;
}) {
  return (
    <PressableScale
      depth="subtle"
      haptic="tap"
      hapticsEnabled={hapticsEnabled}
      onPress={onPress}
      style={styles.nudge}
    >
      <View style={styles.nudgeIcon}>
        <Text style={styles.nudgeQGlyph}>?</Text>
      </View>
      <View style={styles.nudgeText}>
        <Text preset="bodyStrong">New here? How GOLAZO works</Text>
        <Text preset="caption" muted>
          Bet the play, get paid in seconds — a 60-second read.
        </Text>
      </View>
      <View style={styles.nudgeArrow} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  staticDot: { width: 6, height: 6, borderRadius: 3 },
  empty: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.huge,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface1,
    paddingHorizontal: spacing.xl,
  },
  emptyGlyph: { fontSize: 40, marginBottom: spacing.xs },
  emptyBody: { maxWidth: 300 },
  emptyCta: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignSelf: "center",
  },
  // — NextMatch ("up next") card —
  next: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glow.cyanSoft,
    backgroundColor: colors.surface1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    overflow: "hidden",
    alignItems: "center",
  },
  nextTopHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
  nextHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "stretch",
    marginBottom: spacing.lg,
  },
  nextEyebrow: {
    ...type.overline,
    fontSize: 10,
    color: colors.cyan,
    letterSpacing: 1.6,
  },
  nextLeague: {
    ...type.caption,
    fontSize: 10,
    color: colors.textFaint,
    flexShrink: 1,
    textAlign: "right",
    marginLeft: spacing.sm,
  },
  nextMatchup: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    alignSelf: "stretch",
  },
  nextSide: { alignItems: "center", gap: spacing.sm, width: 92 },
  nextTeam: {
    ...type.bodyStrong,
    fontSize: 13,
    color: colors.textPrimary,
    textAlign: "center",
  },
  nextCenter: { flex: 1, alignItems: "center", paddingTop: 4 },
  kickoff: { alignItems: "center", gap: 3 },
  kickoffLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.6,
  },
  kickoffValue: {
    ...type.mono,
    fontSize: 22,
    color: colors.textPrimary,
    letterSpacing: 1,
  },
  nextHint: {
    ...type.caption,
    fontSize: 12.5,
    color: colors.textMuted,
    marginTop: spacing.lg,
    maxWidth: 280,
  },
  nudge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.alpha.white06,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  nudgeIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.alpha.cyan,
    borderWidth: 1,
    borderColor: "rgba(22,198,255,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  nudgeQGlyph: { ...type.subtitle, color: colors.cyan, fontSize: 16 },
  nudgeText: { flex: 1, gap: 1 },
  nudgeArrow: {
    width: 8,
    height: 8,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.textFaint,
    transform: [{ rotate: "45deg" }],
  },
});
