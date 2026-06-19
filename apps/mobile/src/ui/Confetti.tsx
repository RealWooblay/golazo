import React, { useEffect, useMemo } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { colors } from "@/theme";

/**
 * Confetti — a lightweight, dependency-free celebration burst (reanimated only —
 * no heavy native confetti lib). Fires on WIN: a fan of colored shards launches
 * up + out from a central origin, spins, and falls under "gravity" while fading.
 *
 * Controlled by a `trigger` counter: bump it (e.g. setTrigger(n => n+1)) to fire
 * a fresh burst each win, even back-to-back. Pointer-events none, full-bleed.
 *
 * @param trigger  bump to fire. 0 = idle (nothing rendered).
 * @param count    number of shards (default 28).
 * @param colors   palette to draw from (default lime/cyan/gold/red/white).
 */
const PALETTE = [
  colors.yes,
  colors.cyan,
  colors.gold,
  colors.no,
  colors.raw.white,
];

export function Confetti({
  trigger,
  count = 28,
  palette = PALETTE,
  originX,
  originY,
}: {
  trigger: number;
  count?: number;
  palette?: readonly string[];
  originX?: number;
  originY?: number;
}) {
  const { width, height } = Dimensions.get("window");
  const ox = originX ?? width / 2;
  const oy = originY ?? height * 0.4;

  // Stable random per-shard params; reshuffled when `count` changes only.
  const shards = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
        const speed = 140 + Math.random() * 220;
        return {
          key: i,
          color: palette[i % palette.length],
          dx: Math.cos(angle) * speed,
          dy: Math.sin(angle) * speed,
          size: 6 + Math.random() * 7,
          rot: (Math.random() - 0.5) * 720,
          delay: Math.random() * 90,
          round: Math.random() > 0.5,
        };
      }),
    [count, palette],
  );

  if (!trigger) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {shards.map(({ key, ...s }) => (
        <Shard key={`${trigger}-${key}`} {...s} ox={ox} oy={oy} fall={height} />
      ))}
    </View>
  );
}

function Shard({
  color,
  dx,
  dy,
  size,
  rot,
  delay,
  round,
  ox,
  oy,
  fall,
}: {
  color: string;
  dx: number;
  dy: number;
  size: number;
  rot: number;
  delay: number;
  round: boolean;
  ox: number;
  oy: number;
  fall: number;
}) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withDelay(
      delay,
      withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
    );
    return () => cancelAnimation(t);
  }, [t, delay]);

  const style = useAnimatedStyle(() => {
    const p = t.value;
    // Launch out then fall: x is ballistic out, y is launch-up then gravity-down.
    const x = dx * p;
    const y = dy * p + fall * 0.9 * p * p; // gravity term
    return {
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${rot * p}deg` },
        { scale: 1 - p * 0.3 },
      ],
      opacity: p < 0.85 ? 1 : (1 - p) / 0.15,
    };
  });

  return (
    <Animated.View
      style={[
        styles.shard,
        {
          left: ox,
          top: oy,
          width: size,
          height: round ? size : size * 0.5,
          borderRadius: round ? size / 2 : 1,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({ shard: { position: "absolute" } });
