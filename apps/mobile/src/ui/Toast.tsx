import React, { useEffect } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors,
  duration,
  radius as radii,
  shadows,
  spacing,
  spring,
  type,
} from "@/theme";

export type ToastTone = "info" | "success" | "danger" | "gold";

const TONE: Record<ToastTone, { border: string; fg: string; glow: ViewStyle }> =
  {
    info: {
      border: colors.glow.cyanSoft,
      fg: colors.cyan,
      glow: shadows.glowCyan,
    },
    success: {
      border: colors.glow.yesSoft,
      fg: colors.yes,
      glow: shadows.glowYes,
    },
    danger: { border: colors.glow.noSoft, fg: colors.no, glow: shadows.glowNo },
    gold: {
      border: colors.glow.goldSoft,
      fg: colors.gold,
      glow: shadows.glowGold,
    },
  };

/**
 * Toast — a transient, top-anchored pill that springs in, holds, then slides
 * away. Controlled: render it with a non-null `message` to show it; it calls
 * `onHide` after `durationMs`. Pass `tone` to color the accent + glow
 * ('success' on a win/lock, 'danger' on a rejected bet, 'gold' on a payout).
 *
 * Drop ONE near the root of a screen (absolute, above content). Re-fires whenever
 * `message` changes (we key the animation on it).
 */
export function Toast({
  message,
  tone = "info",
  durationMs = 1900,
  onHide,
  style,
}: {
  message: string | null;
  tone?: ToastTone;
  durationMs?: number;
  onHide?: () => void;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);
  const t = TONE[tone];

  useEffect(() => {
    if (!message) return;
    progress.value = 0;
    progress.value = withSequence(
      withSpring(1, spring.bouncy),
      withDelay(
        durationMs,
        withTiming(0, { duration: duration.base }, (finished) => {
          if (finished && onHide) runOnJS(onHide)();
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, durationMs]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: (1 - progress.value) * -24 },
      { scale: 0.96 + progress.value * 0.04 },
    ],
  }));

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { top: insets.top + 54 }, animated, style]}
    >
      <View style={[styles.pill, { borderColor: t.border }]}>
        <View style={[styles.dot, { backgroundColor: t.fg }]} />
        <Text style={[type.bodyStrong, styles.text]} numberOfLines={2}>
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: "90%",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    backgroundColor: colors.surface2,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { color: colors.textPrimary, flexShrink: 1 },
});
