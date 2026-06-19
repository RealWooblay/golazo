import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { colors, spacing, spring, type } from "@/theme";
import { Surface, Text } from "@/ui";
import { Crest } from "@/features/lobby/Crest";
import type { FixtureTeam } from "@/features/lobby/fixtures";
import { GlowWash } from "./GlowWash";

/**
 * LiveScoreboard — the cinematic match header. Both crests flank a huge tabular
 * scoreline; a live status row pulses under it with the match minute; and a
 * momentum bar shows which side is pressing right now (driven by the open
 * market's team, or resting neutral when nothing's live).
 *
 * Depth, not a flat fill: the @/ui Surface (gradient body + top-highlight +
 * shadow), a soft team-tinted GlowWash on each flank, and a faint behind-score
 * vignette. A goal makes the relevant numeral POP (spring scale + gold flash) —
 * detected by watching each score for an increase.
 */
export function LiveScoreboard({
  home,
  away,
  scoreHome,
  scoreAway,
  clock,
  /** 'home' | 'away' = who's attacking; undefined = even / nothing live. */
  momentum,
  live = true,
}: {
  home: FixtureTeam;
  away: FixtureTeam;
  scoreHome: number;
  scoreAway: number;
  clock: string;
  momentum?: "home" | "away";
  live?: boolean;
}) {
  return (
    <Surface radius={20} style={styles.card}>
      <GlowWash
        color={colors.raw.surface3}
        opacity={0.7}
        cx="50%"
        cy="30%"
        r="65%"
      />
      <GlowWash
        color={home.colors[0]}
        opacity={0.12}
        cx="6%"
        cy="50%"
        r="55%"
      />
      <GlowWash
        color={away.colors[0]}
        opacity={0.12}
        cx="94%"
        cy="50%"
        r="55%"
      />

      <View style={styles.scoreRow}>
        <View style={styles.side}>
          <Crest team={home} size={48} />
          <Text style={styles.abbr} numberOfLines={1}>
            {home.abbr}
          </Text>
        </View>

        <View style={styles.center}>
          <View style={styles.scoreLine}>
            <ScoreDigit value={scoreHome} />
            <Text style={styles.colon}>:</Text>
            <ScoreDigit value={scoreAway} />
          </View>
          <View style={styles.clockRow}>
            {live ? <PulseDot color={colors.no} size={6} /> : null}
            <Text style={styles.clock}>{clock}</Text>
            {live ? <Text style={styles.liveWord}>LIVE</Text> : null}
          </View>
        </View>

        <View style={styles.side}>
          <Crest team={away} size={48} />
          <Text style={styles.abbr} numberOfLines={1}>
            {away.abbr}
          </Text>
        </View>
      </View>

      <MomentumBar
        momentum={momentum}
        homeColor={home.colors[0]}
        awayColor={away.colors[0]}
      />
    </Surface>
  );
}

/** A single score numeral that springs + gold-flashes when it increments. */
function ScoreDigit({ value }: { value: number }) {
  const scale = useSharedValue(1);
  const flash = useSharedValue(0);
  const prev = useSharedValue(value);

  useEffect(() => {
    if (value > prev.value) {
      scale.value = withSequence(
        withSpring(1.4, { damping: 8, stiffness: 220 }),
        withSpring(1, spring.bouncy),
      );
      flash.value = withSequence(
        withTiming(1, { duration: 120 }),
        withTiming(0, { duration: 560 }),
      );
    }
    prev.value = value;
  }, [value, scale, flash, prev]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const colorStyle = useAnimatedStyle(() => ({
    color: flash.value > 0.01 ? colors.gold : colors.textPrimary,
    textShadowColor: colors.glow.gold,
    textShadowRadius: flash.value * 22,
  }));

  return (
    <Animated.View style={animStyle}>
      <Animated.Text
        style={[styles.score, colorStyle]}
        allowFontScaling={false}
      >
        {value}
      </Animated.Text>
    </Animated.View>
  );
}

/**
 * MomentumBar — a thin bar under the score whose fill leans toward whichever side
 * is attacking. When a market is live it springs toward that team's color and the
 * marker breathes; otherwise it rests in the middle, neutral.
 */
function MomentumBar({
  momentum,
  homeColor,
  awayColor,
}: {
  momentum?: "home" | "away";
  homeColor: string;
  awayColor: string;
}) {
  // 0 = all home (left), 1 = all away (right), 0.5 = even.
  const target = momentum === "home" ? 0.18 : momentum === "away" ? 0.82 : 0.5;
  const lean = useSharedValue(0.5);
  const glow = useSharedValue(0);

  useEffect(() => {
    lean.value = withSpring(target, spring.smooth);
    if (momentum) {
      glow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      );
    } else {
      cancelAnimation(glow);
      glow.value = withTiming(0, { duration: 300 });
    }
    return () => cancelAnimation(glow);
  }, [target, momentum, lean, glow]);

  const leftStyle = useAnimatedStyle(() => ({
    flex: lean.value,
    backgroundColor: homeColor,
  }));
  const rightStyle = useAnimatedStyle(() => ({
    flex: 1 - lean.value,
    backgroundColor: awayColor,
  }));
  const markerStyle = useAnimatedStyle(() => ({
    left: `${lean.value * 100}%`,
    opacity: 0.45 + glow.value * 0.55,
  }));

  return (
    <View style={styles.momentumWrap}>
      <Text style={styles.momentumLabel}>MOMENTUM</Text>
      <View style={styles.momentumTrack}>
        <Animated.View style={[styles.momentumFill, leftStyle]} />
        <Animated.View style={[styles.momentumFill, rightStyle]} />
        <Animated.View
          style={[styles.momentumMarker, markerStyle]}
          pointerEvents="none"
        />
      </View>
    </View>
  );
}

/** Self-contained live pulse dot (halo + core). */
function PulseDot({ color, size = 6 }: { color: string; size?: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(t);
  }, [t]);
  const halo = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.5, 0]),
    transform: [{ scale: interpolate(t.value, [0, 1], [1, 2.6]) }],
  }));
  const core = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [1, 0.55]),
  }));
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
          halo,
        ]}
      />
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
          core,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  side: { alignItems: "center", gap: 7, width: 66 },
  abbr: {
    ...type.subtitle,
    fontSize: 13,
    color: colors.textSecondary,
    letterSpacing: 0.6,
  },
  center: { flex: 1, alignItems: "center" },
  scoreLine: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  score: {
    ...type.hero,
    fontSize: 52,
    color: colors.textPrimary,
    letterSpacing: 1,
  },
  colon: {
    ...type.hero,
    fontSize: 40,
    color: colors.textGhost,
    marginBottom: 5,
  },
  clockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  clock: { ...type.overline, fontSize: 11, color: colors.no },
  liveWord: {
    ...type.overline,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.6,
  },
  momentumWrap: { marginTop: spacing.lg, gap: 6 },
  momentumLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.6,
    textAlign: "center",
  },
  momentumTrack: {
    flexDirection: "row",
    height: 5,
    borderRadius: 999,
    backgroundColor: colors.surface0,
    overflow: "hidden",
  },
  momentumFill: { height: "100%", opacity: 0.85 },
  momentumMarker: {
    position: "absolute",
    top: -2,
    width: 2,
    height: 9,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: colors.textPrimary,
  },
});
