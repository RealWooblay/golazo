import React, { useEffect, useState } from "react";
import { type TextStyle } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
  withTiming,
  type WithSpringConfig,
  type WithTimingConfig,
} from "react-native-reanimated";
import { duration as dur, easing, spring } from "@/theme";

/**
 * AnimatedNumber — a number that smoothly counts to its target instead of
 * snapping. The app's money/odds ticker: balance count-ups, the live pool total,
 * YES/NO multiples. Animates a reanimated shared value on the UI thread, mirrors
 * it to JS only when the FORMATTED string changes (so we don't re-render per
 * frame), and renders tabular text (digits don't jitter).
 *
 * Two motion modes:
 *   • spring (default 'smooth') — weighty count-up for balance/wins.
 *   • timing — pass `duration` to use a timed ease instead.
 *
 * Pass a `style` built from a display/mono `type.*` preset (already tabular).
 *
 * @param value   target number
 * @param format  value -> display string (e.g. money, multiple)
 * @param spring  spring preset to use (default 'smooth'); ignored if `duration` set
 * @param duration if set, animate with timing over this many ms instead of spring
 */
export function AnimatedNumber({
  value,
  format,
  spring: springConfig = spring.smooth,
  duration,
  style,
}: {
  value: number;
  format: (n: number) => string;
  spring?: WithSpringConfig;
  duration?: number;
  style?: TextStyle | TextStyle[];
}) {
  const sv = useSharedValue(value);
  const [display, setDisplay] = useState(() => format(value));

  useEffect(() => {
    if (typeof duration === "number") {
      const cfg: WithTimingConfig = {
        duration: duration ?? dur.base,
        easing: easing.out,
      };
      sv.value = withTiming(value, cfg);
    } else {
      sv.value = withSpring(value, springConfig);
    }
    return () => cancelAnimation(sv);
  }, [value, duration, sv, springConfig]);

  useAnimatedReaction(
    () => sv.value,
    (curr) => {
      runOnJS(setDisplay)(format(curr));
    },
  );

  return <Animated.Text style={style}>{display}</Animated.Text>;
}
