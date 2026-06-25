import React, { useId } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

/**
 * GlowWash — a soft, free-color radial glow used behind hero moments on the match
 * screen (team-tinted flank washes, the live card halo, the goal flash). The
 * `@/ui` Vignette only takes preset tints, so this is the match feature's
 * arbitrary-color sibling. Pure react-native-svg → web-safe, no new deps, and it
 * never intercepts taps (pointer-events none).
 */
export function GlowWash({
  color,
  opacity = 0.5,
  cx = "50%",
  cy = "40%",
  r = "70%",
  style,
}: {
  color: string;
  opacity?: number;
  cx?: string;
  cy?: string;
  r?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const id = `mwash_${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Keep the canvas flat: cap the wash so even hero/celebration callers read as a faint
  // tint, never a full bloom (the old 0.5 washes were the "AI slop" look).
  const op = Math.min(opacity, 0.1);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id={id} cx={cx} cy={cy} r={r}>
            <Stop offset="0%" stopColor={color} stopOpacity={op} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
