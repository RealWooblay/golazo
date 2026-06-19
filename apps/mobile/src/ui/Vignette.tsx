import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors } from "@/theme";

/**
 * Vignette — a soft radial wash placed BEHIND hero moments (the live scoreboard,
 * the win burst, a market that just opened) to lift them off the near-black
 * canvas. It's the depth counterpart to {@link GrainOverlay}: grain sits on top
 * to kill banding, vignette sits behind to focus the eye.
 *
 * Pointer-events none, absolutely filled by default. Drop it as the FIRST child
 * of a container:
 *   <View><Vignette tint="yes" />{hero}</View>
 *
 * @param tint     center color — 'yes' | 'no' | 'gold' | 'cyan' | 'neutral'.
 * @param intensity center opacity (0..1, default 0.5). Edge always fades to 0.
 * @param cx/cy/r  radial center + radius as 0..1 fractions (default centered, 0.8).
 */
export function Vignette({
  tint = "neutral",
  intensity = 0.5,
  cx = 0.5,
  cy = 0.42,
  r = 0.85,
  style,
}: {
  tint?: "yes" | "no" | "gold" | "cyan" | "neutral";
  intensity?: number;
  cx?: number;
  cy?: number;
  r?: number;
  style?: ViewStyle;
}) {
  const center =
    tint === "yes"
      ? colors.yes
      : tint === "no"
        ? colors.no
        : tint === "gold"
          ? colors.gold
          : tint === "cyan"
            ? colors.cyan
            : colors.bgGradientTop;

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient
            id="uiVignette"
            cx={`${cx * 100}%`}
            cy={`${cy * 100}%`}
            r={`${r * 100}%`}
          >
            <Stop offset="0" stopColor={center} stopOpacity={intensity} />
            <Stop
              offset="0.7"
              stopColor={center}
              stopOpacity={intensity * 0.25}
            />
            <Stop offset="1" stopColor={center} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#uiVignette)" />
      </Svg>
    </View>
  );
}
