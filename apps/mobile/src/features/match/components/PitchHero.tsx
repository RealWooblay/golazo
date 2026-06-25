import React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Line, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { Crest } from "@/features/lobby/Crest";
import type { FixtureTeam } from "@/features/lobby/fixtures";

/**
 * PitchHero — the immersive "you're watching the match" hero for the LIVE SESSION only.
 *
 * A full-bleed stadium pitch (radial green field + centre circle + halfway line) with a
 * frosted broadcast lower-third carrying the live scoreline. This is the Pitch design
 * direction's signature; it lives ONLY on the live match screen so it never collides with
 * other sports later. Flat, no glow — depth comes from the field gradient + a glass panel.
 */
export function PitchHero({
  home,
  away,
  scoreHome,
  scoreAway,
  clock,
  status,
  momentumLean,
  note,
}: {
  home: FixtureTeam;
  away: FixtureTeam;
  scoreHome: number;
  scoreAway: number;
  clock: string;
  status: "pre" | "live" | "halftime" | "final";
  /** 0 = home pressing … 1 = away pressing; 0.5 even. */
  momentumLean?: number | null;
  /** the hot live moment / commentary headline. */
  note?: string;
}) {
  const live = status === "live";
  const label = status === "final" ? "FT" : status === "halftime" ? "HT" : clock;
  const homeShare =
    typeof momentumLean === "number" ? Math.min(0.85, Math.max(0.15, 1 - momentumLean)) : 0.5;

  return (
    <View style={styles.hero}>
      {/* the pitch */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <RadialGradient id="pitchField" cx="50%" cy="14%" r="100%">
            <Stop offset="0" stopColor="#2A8F5C" />
            <Stop offset="0.5" stopColor="#11593607" stopOpacity={1} />
            <Stop offset="0.5" stopColor="#115936" />
            <Stop offset="1" stopColor="#06231A" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#pitchField)" />
        <Line x1="50%" y1="0" x2="50%" y2="100%" stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1.5} />
        <Circle cx="50%" cy="44%" r="64" stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1.5} fill="none" />
        <Circle cx="50%" cy="44%" r="3" fill="#ffffff" fillOpacity={0.18} />
      </Svg>

      {/* live ticker headline */}
      {note ? (
        <View style={styles.note}>
          <View style={styles.noteDot} />
          <Text style={styles.noteText} numberOfLines={1}>
            {note}
          </Text>
        </View>
      ) : null}

      {/* frosted broadcast lower-third — symmetric: home · score · away, score centred */}
      <View style={styles.glass}>
        <View style={styles.side}>
          <Crest team={home} size={28} />
          <Text style={styles.teamAbbr}>{home.abbr}</Text>
        </View>

        <View style={styles.center}>
          <View style={styles.clockRow}>
            {live ? <View style={styles.liveDot} /> : null}
            <Text style={styles.clock}>{live ? `${label} · LIVE` : label}</Text>
          </View>
          <Text style={styles.score} allowFontScaling={false}>
            {scoreHome}
            <Text style={styles.scoreSep}> : </Text>
            {scoreAway}
          </Text>
        </View>

        <View style={styles.side}>
          <Crest team={away} size={28} />
          <Text style={styles.teamAbbr}>{away.abbr}</Text>
        </View>
      </View>

      {/* momentum sliver along the very bottom edge */}
      <View style={styles.momentum}>
        <View style={{ flex: homeShare, backgroundColor: colors.home }} />
        <View style={{ flex: 1 - homeShare, backgroundColor: colors.away }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    height: 230,
    borderRadius: radius.lg,
    overflow: "hidden",
    justifyContent: "flex-end",
    backgroundColor: "#0d4a2c",
  },
  note: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(6,20,13,0.55)",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  noteDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.cyan },
  noteText: { ...type.caption, fontSize: 12.5, color: "#dfeee7", flex: 1 },
  glass: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    margin: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: "rgba(7,16,11,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: radius.md,
  },
  side: { flex: 1, alignItems: "center", gap: 5 },
  center: { alignItems: "center", gap: 1 },
  clockRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.yes },
  clock: { ...type.overline, fontSize: 10, letterSpacing: 0.6, color: "#bfe0d2" },
  teamAbbr: { ...type.overline, fontSize: 11, color: "#dfeee7", letterSpacing: 0.4 },
  score: { ...type.display, fontSize: 32, color: "#ffffff" },
  scoreSep: { color: "rgba(255,255,255,0.4)" },
  momentum: { flexDirection: "row", height: 3 },
});
