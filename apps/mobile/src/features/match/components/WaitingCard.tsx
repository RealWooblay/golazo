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
 * WaitingCard — the between-moments idle state. NOT a dead empty box: a soft
 * "scanning the pitch" radar with concentric pulse rings + a sweeping line, an
 * on-brand line of copy, and a hint that the next attack opens a market any
 * second. Keeps the stage feeling live while the sim builds the next moment.
 */
export function WaitingCard({
  title = "Reading the game…",
  body = "A market pops the second something kicks off. Stay sharp.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <Surface radius={radius.xl} style={styles.card}>
      <GlowWash
        color={colors.raw.cyan}
        opacity={0.08}
        cx="50%"
        cy="38%"
        r="60%"
      />
      <Radar />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body} center>
        {body}
      </Text>
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
  // a half-width bar offset to the right of center, so it sweeps like a radar arm
  // about the radar's center as the wrapper rotates (no transformOrigin needed).
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
