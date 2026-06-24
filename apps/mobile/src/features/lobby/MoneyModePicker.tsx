import React, { useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors, radius, shadows, type } from "@/theme";
import { Pressable, Text } from "@/ui";
import type { MoneyMode } from "@/state/types";

const SEGMENTS: { key: MoneyMode; label: string; sub: string; tint: string }[] = [
  { key: "real", label: "Real", sub: "Devnet SOL", tint: colors.cyan },
  { key: "points", label: "Paper", sub: "Fake points", tint: colors.yes },
];

const TRACK_PAD = 4;

/**
 * MoneyModePicker — Real vs Paper as a single segmented control with a sliding
 * thumb whose accent morphs cyan→gold as it travels. Both modes feed the ONE
 * global points leaderboard; real mode also stakes devnet SOL against the book.
 */
export function MoneyModePicker({
  value,
  onChange,
  hapticsEnabled,
}: {
  value: MoneyMode;
  onChange: (mode: MoneyMode) => void;
  hapticsEnabled: boolean;
}) {
  const index = value === "real" ? 0 : 1;
  const [trackW, setTrackW] = useState(0);
  const segW = trackW > 0 ? (trackW - TRACK_PAD * 2) / 2 : 0;

  const pos = useSharedValue(index);
  useEffect(() => {
    pos.value = withTiming(index, { duration: 240 });
  }, [index, pos]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: TRACK_PAD + pos.value * segW }],
    borderColor: interpolateColor(pos.value, [0, 1], [colors.cyan, colors.yes]),
  }));

  const onLayout = (e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width);

  return (
    <View style={styles.track} onLayout={onLayout}>
      {segW > 0 ? (
        <Animated.View
          style={[styles.thumb, { width: segW }, thumbStyle]}
          pointerEvents="none"
        />
      ) : null}
      {SEGMENTS.map((seg) => {
        const active = seg.key === value;
        return (
          <Pressable
            key={seg.key}
            haptic="select"
            enabledHaptics={hapticsEnabled}
            onPress={() => onChange(seg.key)}
            style={styles.seg}
          >
            <Text style={[styles.label, active && styles.labelOn]}>
              {seg.label}
            </Text>
            <Text
              style={[styles.sub, active && { color: seg.tint }]}
              numberOfLines={1}
            >
              {seg.sub}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignItems: "stretch",
    height: 54,
    padding: TRACK_PAD,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface1,
    position: "relative",
  },
  thumb: {
    position: "absolute",
    top: TRACK_PAD,
    bottom: TRACK_PAD,
    left: 0,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.surface3,
    ...shadows.sm,
  },
  seg: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  label: {
    ...type.bodyStrong,
    fontSize: 14,
    color: colors.textMuted,
  },
  labelOn: { color: colors.textPrimary },
  sub: {
    ...type.caption,
    fontSize: 10,
    color: colors.textFaint,
  },
});
