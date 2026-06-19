import React, { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { duration as dur } from "@/theme";

/**
 * Shimmer — a soft white highlight that sweeps left→right on a loop. Layered over
 * the pool split-bar (the "money flowing in" feel), the ProgressBar, and Skeleton
 * loaders. Pointer-events none; never blocks taps.
 *
 * @param width    sweep distance in px (default 320 — set to the parent width).
 * @param running  pause the loop (e.g. once a market locks).
 * @param opacity  peak band strength (default 0.14).
 */
export function Shimmer({
  width = 320,
  height = 8,
  running = true,
  opacity = 0.14,
  style,
}: {
  width?: number;
  height?: number;
  running?: boolean;
  opacity?: number;
  style?: ViewStyle;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!running) {
      cancelAnimation(progress);
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: dur.shimmer, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [running, progress, width]);

  const band = Math.max(40, width * 0.4);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(progress.value, [0, 1], [-band, width]) },
    ],
  }));

  if (!running) return null;

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.clip, style]}
    >
      <Animated.View style={[{ width: band, height }, animatedStyle]}>
        <Svg width={band} height={height}>
          <Defs>
            <LinearGradient id="uiShimmer" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
              <Stop offset="0.5" stopColor="#ffffff" stopOpacity={opacity} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width={band} height={height} fill="url(#uiShimmer)" />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({ clip: { overflow: "hidden" } });
