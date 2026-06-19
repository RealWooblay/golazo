import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";

/**
 * CommentaryTicker — the live play-by-play line. On every new commentary string it
 * slides the old line up + out and drops the new one in (mirrors the prototype's
 * ticker), so the match always feels narrated and alive. A cyan "LIVE" pulse dot
 * anchors the left so an unchanged line still reads as a broadcast, not dead text.
 */
export function CommentaryTicker({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const y = useSharedValue(0);
  const opacity = useSharedValue(1);
  const last = useRef(text);

  useEffect(() => {
    if (text === last.current) return;
    last.current = text;
    // Swap the line immediately, then drop it in from just above and settle to
    // 0 (the vertically-centered rest). We always animate back to 0 so the line
    // can never get parked off-center when commentary fires faster than the
    // settle (the old slide-up-and-out left y stuck at -12 on rapid updates).
    runOnJS(setShown)(text);
    opacity.value = withSequence(
      withTiming(0, { duration: 120 }),
      withTiming(1, { duration: 240 }),
    );
    y.value = withSequence(
      withTiming(-10, { duration: 120, easing: Easing.in(Easing.quad) }),
      withTiming(0, { duration: 240, easing: Easing.out(Easing.cubic) }),
    );
  }, [text, y, opacity]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: y.value }],
  }));

  return (
    <View style={styles.wrap}>
      <PulseDot />
      <View style={styles.lineClip}>
        <Animated.Text style={[styles.line, animStyle]} numberOfLines={1}>
          {shown}
        </Animated.Text>
      </View>
    </View>
  );
}

function PulseDot() {
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
  return (
    <View style={styles.dotWrap}>
      <Animated.View style={[styles.dotHalo, halo]} />
      <View style={styles.dotCore} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.alpha.white06,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    overflow: "hidden",
  },
  lineClip: {
    flex: 1,
    height: 36,
    justifyContent: "center",
    overflow: "hidden",
  },
  line: {
    ...type.caption,
    color: colors.textSecondary,
    fontSize: 12.5,
    // Match line box to render height so glyphs sit centered (not the inherited
    // caption lineHeight of 16.8, which pushed the text off-center / clipped it).
    lineHeight: 18,
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  dotWrap: {
    width: 7,
    height: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  dotHalo: {
    position: "absolute",
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.cyan,
  },
  dotCore: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.cyan,
  },
});
