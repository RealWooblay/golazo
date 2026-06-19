import React, { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { colors, duration as dur, type } from "@/theme";
import { Text } from "@/ui";
import { haptics } from "@/ui/haptics";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 72;
const R = 30;
const STROKE = 6;
const CIRC = 2 * Math.PI * R;
const URGENT_AT = 3; // seconds — flip to red + pulse + haptic tick

/**
 * CountdownRing — the betting-window timer, leveled up from the prototype:
 *
 *   • a GRADIENT sweep (calm lime→cyan; urgent gold→red in the last 3s),
 *   • a soft breathing pulse (scale) every second once urgent,
 *   • a HAPTIC tick on each whole-second boundary in the final 3s,
 *   • the big tabular seconds numeral in the centre (a ⏳ hold glyph when locked).
 *
 * Pure function of `fraction` (1 = just opened → 0 = locking) and `seconds`. The
 * parent derives both from the engine's `lockAt` + a shared tick, so the ring can
 * never drift from the real lock time. Pass `locked` once betting closes.
 */
export function CountdownRing({
  fraction,
  seconds,
  locked = false,
  hapticsEnabled = true,
}: {
  fraction: number;
  seconds: number;
  locked?: boolean;
  hapticsEnabled?: boolean;
}) {
  const f = Math.max(0, Math.min(1, fraction));
  const secsLeft = Math.max(0, Math.ceil(seconds));
  const urgent = !locked && secsLeft <= URGENT_AT && secsLeft > 0;

  // dashoffset grows as time drains (0 = full ring → CIRC = empty).
  const offset = useSharedValue(CIRC * (1 - f));
  useEffect(() => {
    offset.value = withTiming(CIRC * (1 - (locked ? 0 : f)), {
      duration: dur.instant,
    });
  }, [f, locked, offset]);

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: offset.value,
  }));

  // Urgency pulse: a gentle breathing scale on the whole ring in the last 3s.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (urgent) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.09, { duration: dur.pulse / 2 }),
          withTiming(1, { duration: dur.pulse / 2 }),
        ),
        -1,
        true,
      );
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: dur.fast });
    }
    return () => cancelAnimation(pulse);
  }, [urgent, pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  // Haptic tick on each whole-second boundary inside the urgent window.
  const lastTick = useRef<number>(-1);
  useEffect(() => {
    if (urgent && secsLeft !== lastTick.current) {
      lastTick.current = secsLeft;
      if (hapticsEnabled) haptics.tap();
    }
    if (!urgent) lastTick.current = -1;
  }, [urgent, secsLeft, hapticsEnabled]);

  const [from, to] = locked
    ? [colors.gold, colors.raw.goldDeep]
    : urgent
      ? [colors.gold, colors.raw.redDeep]
      : [colors.primary, colors.cyan];

  return (
    <Animated.View style={[styles.ring, pulseStyle]}>
      <Svg width={SIZE} height={SIZE}>
        <Defs>
          <LinearGradient id="golazoRing" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          stroke={colors.hairline}
          strokeWidth={STROKE}
          fill="none"
        />
        <AnimatedCircle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          stroke="url(#golazoRing)"
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${CIRC} ${CIRC}`}
          animatedProps={ringProps}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </Svg>
      <View style={styles.numWrap} pointerEvents="none">
        {locked ? (
          <Text style={styles.lock}>⏳</Text>
        ) : (
          <Text
            style={[styles.num, urgent && styles.numUrgent]}
            allowFontScaling={false}
          >
            {secsLeft}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  ring: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  numWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  num: { ...type.display, fontSize: 26, color: colors.textPrimary },
  numUrgent: { color: colors.no },
  lock: { fontSize: 22 },
});
