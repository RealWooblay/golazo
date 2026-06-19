import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, radius as radii, shadows } from "@/theme";

export type GlowKind = "yes" | "no" | "gold" | "cyan";

/**
 * Surface — the layered card the whole app sits on. Gives every panel real depth
 * instead of a flat fill:
 *   • a vertical gradient body (lighter top → darker base),
 *   • a hairline border + a 1px TOP-EDGE highlight so the card catches light,
 *   • a soft, large-radius shadow.
 *
 * Drawn with react-native-svg (already installed, web-safe) so we don't hard-
 * depend on expo-linear-gradient for the body.
 *
 * @param elevated   bump the gradient one elevation step (surface3→2 vs 2→1).
 * @param glow       wash a colored ambient halo behind a LIVE/active surface.
 * @param radius     corner radius (default radii.lg).
 * @param borderColor override the hairline (e.g. a tinted active border).
 * @param padded     apply standard inner padding (spacing.lg). Default false.
 */
export function Surface({
  children,
  style,
  radius = radii.lg,
  elevated = false,
  glow,
  borderColor,
}: {
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  radius?: number;
  elevated?: boolean;
  glow?: GlowKind;
  borderColor?: string;
}) {
  const stops = elevated
    ? [colors.surface3, colors.surface2]
    : [colors.surface2, colors.surface1];
  const glowShadow =
    glow === "yes"
      ? shadows.glowLive
      : glow === "no"
        ? shadows.glowNo
        : glow === "gold"
          ? shadows.glowGold
          : glow === "cyan"
            ? shadows.glowCyan
            : shadows.md;

  return (
    <View
      style={[
        styles.base,
        { borderRadius: radius, borderColor: borderColor ?? colors.hairline },
        glowShadow,
        style,
      ]}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: radius, overflow: "hidden" },
        ]}
      >
        <Svg width="100%" height="100%" pointerEvents="none">
          <Defs>
            <LinearGradient id="uiSurfaceBody" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={stops[0]} />
              <Stop offset="1" stopColor={stops[1]} />
            </LinearGradient>
            <LinearGradient id="uiSurfaceHL" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.07} />
              <Stop offset="0.04" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#uiSurfaceBody)" />
          <Rect width="100%" height="100%" fill="url(#uiSurfaceHL)" />
        </Svg>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth > 1 ? StyleSheet.hairlineWidth : 1,
    overflow: "hidden",
  },
});
