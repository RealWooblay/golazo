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
  withTiming,
} from "react-native-reanimated";
import { colors, radius, spacing, type } from "@/theme";
import { Surface, Text } from "@/ui";
import { GlowWash } from "./GlowWash";

/**
 * WaitingCard — the between-moments idle state. NOT a dead empty box.
 *
 * In LIVE mode (a commentaryLog is supplied) it shows the match breathing: the live
 * clock, a who's-pressing pressure bar, a "next market any second" teaser, and a
 * rolling play-by-play ticker — so the wait between markets feels alive. With no live
 * data it falls back to the ambient "scanning the pitch" radar + a line of copy.
 */
export function WaitingCard({
  title = "Reading the game…",
  body = "A market pops the second something kicks off. Stay sharp.",
  clock,
  commentaryLog,
  momentumLean,
  momentum,
  homeName,
  awayName,
}: {
  title?: string;
  body?: string;
  clock?: string;
  commentaryLog?: string[];
  momentumLean?: number | null;
  momentum?: "home" | "away" | null;
  homeName?: string;
  awayName?: string;
}) {
  const plays = (commentaryLog ?? []).slice(-3).reverse();
  const live = plays.length > 0;

  if (!live) {
    return (
      <Surface radius={radius.xl} style={styles.card}>
        <GlowWash color={colors.raw.cyan} opacity={0.08} cx="50%" cy="38%" r="60%" />
        <Radar />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body} center>
          {body}
        </Text>
      </Surface>
    );
  }

  const pressingName =
    momentum === "home" ? homeName : momentum === "away" ? awayName : undefined;
  const lean = typeof momentumLean === "number" ? momentumLean : null;

  return (
    <Surface radius={radius.xl} style={styles.liveCard}>
      <GlowWash color={colors.raw.cyan} opacity={0.07} cx="50%" cy="22%" r="70%" />

      <View style={styles.headRow}>
        {clock ? (
          <View style={styles.clockPill}>
            <View style={styles.liveDot} />
            <Text style={styles.clockText}>{clock}</Text>
          </View>
        ) : null}
        <Text style={styles.teaser} numberOfLines={1}>
          {pressingName
            ? `${pressingName} pressing — next market any second`
            : "Scanning the pitch for the next moment…"}
        </Text>
      </View>

      {lean !== null ? (
        <View style={styles.pressureTrack}>
          <View style={[styles.pressureHome, { flex: Math.max(0.001, 1 - lean) }]} />
          <View style={[styles.pressureAway, { flex: Math.max(0.001, lean) }]} />
        </View>
      ) : null}

      <View style={styles.ticker}>
        {plays.map((line, i) => (
          <Text
            key={`${i}-${line.slice(0, 12)}`}
            style={[styles.play, i === 0 && styles.playLatest]}
            numberOfLines={2}
          >
            {line}
          </Text>
        ))}
      </View>
    </Surface>
  );
}

function Radar() {
  const sweep = useSharedValue(0);
  const ping = useSharedValue(0);

  useEffect(() => {
    sweep.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.linear }),
      -1,
      false,
    );
    ping.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(sweep);
      cancelAnimation(ping);
    };
  }, [sweep, ping]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${sweep.value * 360}deg` }],
  }));
  const pingStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ping.value, [0, 0.2, 1], [0, 0.5, 0]),
    transform: [{ scale: interpolate(ping.value, [0, 1], [0.3, 1]) }],
  }));

  return (
    <View style={styles.radar}>
      <View style={[styles.ring, styles.ringOuter]} />
      <View style={[styles.ring, styles.ringInner]} />
      <Animated.View
        style={[styles.ring, styles.ringOuter, styles.ringPing, pingStyle]}
      />
      <Animated.View
        style={[styles.sweepWrap, sweepStyle]}
        pointerEvents="none"
      >
        <View style={styles.sweepArm} />
      </Animated.View>
      <View style={styles.core} />
    </View>
  );
}

const RADAR = 72;

const styles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 220,
    justifyContent: "center",
  },
  liveCard: {
    padding: spacing.lg,
    gap: spacing.md,
    minHeight: 180,
    justifyContent: "center",
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  clockPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.alpha.white06,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.yes,
  },
  clockText: { ...type.mono, fontSize: 13, color: colors.textPrimary },
  teaser: {
    ...type.body,
    flex: 1,
    fontSize: 13,
    color: colors.textMuted,
  },
  pressureTrack: {
    flexDirection: "row",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: colors.alpha.white06,
  },
  pressureHome: { backgroundColor: colors.yes, opacity: 0.7 },
  pressureAway: { backgroundColor: colors.cyan, opacity: 0.7 },
  ticker: { gap: 4 },
  play: {
    ...type.body,
    fontSize: 12.5,
    color: colors.textMuted,
    opacity: 0.6,
  },
  playLatest: {
    color: colors.textPrimary,
    opacity: 1,
  },
  radar: {
    width: RADAR,
    height: RADAR,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  ring: {
    position: "absolute",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  ringOuter: { width: RADAR, height: RADAR },
  ringInner: { width: RADAR * 0.58, height: RADAR * 0.58 },
  ringPing: { borderColor: colors.cyan },
  sweepWrap: {
    position: "absolute",
    width: RADAR,
    height: RADAR,
    alignItems: "center",
    justifyContent: "center",
  },
  sweepArm: {
    position: "absolute",
    left: RADAR / 2,
    width: RADAR / 2,
    height: 2,
    backgroundColor: colors.cyan,
    opacity: 0.65,
  },
  core: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.cyan,
  },
  title: { ...type.title, fontSize: 18, color: colors.textPrimary },
  body: {
    ...type.body,
    fontSize: 13.5,
    color: colors.textMuted,
    maxWidth: 260,
  },
});
