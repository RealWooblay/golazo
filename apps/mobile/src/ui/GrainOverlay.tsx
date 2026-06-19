import React, { useMemo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Rect } from "react-native-svg";

/**
 * GrainOverlay — a faint, full-bleed noise texture that sits ON TOP of a surface
 * to kill flat-fill banding and give the stadium-at-night depth. Pointer-events
 * none, so it never intercepts taps.
 *
 * IMPLEMENTATION NOTE: react-native-svg (15.x) does not expose SVG filter
 * primitives (feTurbulence) in its public/typed API across platforms, so instead
 * of relying on a filter we scatter many tiny, low-opacity speckles
 * deterministically. At ~3% opacity this reads as fine film grain and is fully
 * type-safe + web-safe (plain <Rect>s). Grain is a "last 5%" detail — keep it
 * whisper-quiet.
 *
 * Place it absolutely-filled as the LAST child of a container:
 *   <View>{content}<GrainOverlay /></View>
 *
 * @param opacity  overall strength (default 0.035).
 * @param density  number of speckles (default 140). Higher = finer/denser.
 * @param size     viewBox tile size the speckles are laid out in (default 100).
 */
export function GrainOverlay({
  opacity = 0.035,
  density = 140,
  size = 100,
  style,
}: {
  opacity?: number;
  density?: number;
  size?: number;
  style?: ViewStyle;
}) {
  // Deterministic pseudo-random speckle field (stable across renders).
  const speckles = useMemo(() => {
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    return Array.from({ length: density }).map((_, i) => ({
      key: i,
      x: rand() * size,
      y: rand() * size,
      s: 0.6 + rand() * 0.9,
      o: 0.4 + rand() * 0.6,
      light: rand() > 0.5,
    }));
  }, [density, size]);

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity }, style]}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${size} ${size}`}
        preserveAspectRatio="none"
      >
        {speckles.map((p) => (
          <Rect
            key={p.key}
            x={p.x}
            y={p.y}
            width={p.s}
            height={p.s}
            fill={p.light ? "#ffffff" : "#000000"}
            opacity={p.o}
          />
        ))}
      </Svg>
    </View>
  );
}
