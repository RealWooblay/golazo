import React from "react";
import {
  StyleSheet,
  View,
  type DimensionValue,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { colors, duration, radius as radii, spacing } from "@/theme";

/**
 * Skeleton — a pulsing placeholder block for loading states (lobby fixtures,
 * the market card before the first moment, the activity list). Gently breathes
 * its opacity so a loading screen still feels alive, not frozen.
 *
 * Compose several into a shape with {@link SkeletonGroup} / plain Views.
 *
 * @param width/height  px or '%'. Height default 14 (a text line).
 * @param radius        corner radius (default radii.sm).
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = radii.sm,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const v = useSharedValue(0.5);
  React.useEffect(() => {
    v.value = withRepeat(
      withSequence(
        withTiming(1, { duration: duration.dot }),
        withTiming(0.4, { duration: duration.dot }),
      ),
      -1,
      true,
    );
    return () => cancelAnimation(v);
  }, [v]);

  const animated = useAnimatedStyle(() => ({ opacity: v.value }));

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius },
        styles.block,
        animated,
        style,
      ]}
    />
  );
}

/** A vertical stack of skeleton lines (a quick paragraph/list placeholder). */
export function SkeletonGroup({
  lines = 3,
  gap = spacing.sm,
  lineHeight = 12,
  lastLineWidth = "60%",
}: {
  lines?: number;
  gap?: number;
  lineHeight?: number;
  lastLineWidth?: DimensionValue;
}) {
  return (
    <View style={{ gap }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={i === lines - 1 ? lastLineWidth : "100%"}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.surface2, overflow: "hidden" },
});
