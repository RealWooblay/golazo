import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, spring } from "@/theme";
import { Shimmer } from "./Shimmer";

type Tone = "yes" | "no" | "cyan" | "gold" | "split";

const FILL: Record<Exclude<Tone, "split">, readonly [string, string]> = {
  yes: [colors.raw.limeBright, colors.raw.limeDeep],
  no: [colors.raw.redBright, colors.raw.redDeep],
  cyan: [colors.raw.cyan, colors.raw.cyanDeep],
  gold: [colors.raw.gold, colors.raw.goldDeep],
};

/**
 * ProgressBar — a rounded track with a spring-animated fill, optionally shimmering
 * (the "live" feel). Two modes:
 *
 *   • Single fill: pass `value` (0..1) and a `tone`. Used for deposit progress,
 *     a generic meter, the countdown bar.
 *   • Split bar: pass `tone="split"` + `value` as the YES share (0..1). The bar
 *     fills lime from the left and red from the right, meeting at `value` — the
 *     pool split bar from the prototype. Shimmer rides the YES side.
 *
 * @param value     0..1. For split, the YES fraction.
 * @param shimmer   ride a shimmer sweep across the fill (default true while live).
 * @param height    bar thickness (default 10).
 * @param width     pixel width — needed for the shimmer sweep distance.
 */
export function ProgressBar({
  value,
  tone = "yes",
  shimmer = true,
  height = 10,
  width = 320,
  style,
}: {
  value: number;
  tone?: Tone;
  shimmer?: boolean;
  height?: number;
  width?: number;
  style?: ViewStyle;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const sv = useDerivedValue(
    () => withSpring(clamped, spring.snappy),
    [clamped],
  );

  const fillStyle = useAnimatedStyle(() => ({ width: `${sv.value * 100}%` }));
  const rightStyle = useAnimatedStyle(() => ({
    width: `${(1 - sv.value) * 100}%`,
  }));

  if (tone === "split") {
    return (
      <View style={[styles.track, { height, borderRadius: height / 2 }, style]}>
        <Animated.View style={[styles.seg, fillStyle]}>
          <GradientFill colors={FILL.yes} id="uiPbYes" />
        </Animated.View>
        <Animated.View style={[styles.seg, rightStyle]}>
          <GradientFill colors={FILL.no} id="uiPbNo" />
        </Animated.View>
        {shimmer ? (
          <Shimmer width={width} height={height} opacity={0.16} />
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }, style]}>
      <Animated.View style={[styles.seg, fillStyle]}>
        <GradientFill colors={FILL[tone]} id={`uiPb-${tone}`} />
        {shimmer ? (
          <Shimmer width={width} height={height} opacity={0.18} />
        ) : null}
      </Animated.View>
    </View>
  );
}

function GradientFill({
  colors: stops,
  id,
}: {
  colors: readonly [string, string];
  id: string;
}) {
  return (
    <Svg
      width="100%"
      height="100%"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={stops[0]} />
          <Stop offset="1" stopColor={stops[1]} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    overflow: "hidden",
    backgroundColor: colors.surface0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  seg: { height: "100%", overflow: "hidden" },
});
