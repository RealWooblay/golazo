import React from "react";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, radius as radii, shadows, type RadiusKey } from "@/theme";

/**
 * Surface — the canonical GOLAZO "card": a layered, large-radius panel with a
 * subtle vertical gradient (top lifts to a darker base), a 1px top-edge highlight
 * hairline for real depth, a hairline border, and a soft large-radius shadow.
 *
 * WHY a custom primitive instead of <LinearGradient>/<BlurView>:
 *   The app MUST render on Expo Web (we verify via screenshots). `react-native-svg`
 *   is a guaranteed dependency and renders identically on web + native, so the
 *   gradient comes from an inline SVG <Rect> behind the content. No native-only
 *   lib at module load → web can never break on import.
 *
 * Use it for every elevated block in the wallet surface so depth stays consistent.
 *
 *   <Surface level={2} radius="lg" glow="yes" style={...}>{children}</Surface>
 */

type GlowName = "none" | "yes" | "no" | "cyan" | "gold";

const GRADIENTS: Record<number, readonly [string, string]> = {
  0: [colors.surface1, colors.surface0],
  1: [colors.surface2, colors.surface1],
  2: [colors.surface3, colors.surface2],
  3: ["#2b2f40", colors.surface3],
};

const GLOW_SHADOW: Record<GlowName, ViewStyle> = {
  none: shadows.md as ViewStyle,
  yes: shadows.glowYes as ViewStyle,
  no: shadows.glowNo as ViewStyle,
  cyan: shadows.glowCyan as ViewStyle,
  gold: shadows.glowGold as ViewStyle,
};

export interface SurfaceProps extends ViewProps {
  /** Elevation 0 (lowest) → 3 (highest). Picks the gradient + base tone. */
  level?: 0 | 1 | 2 | 3;
  radius?: RadiusKey;
  /** Colored halo — use surgically, only for live/active states. */
  glow?: GlowName;
  /** Border colour override (e.g. an active YES/NO selection). */
  borderColor?: string;
  /** Render the top-edge highlight hairline (default true). */
  topHighlight?: boolean;
  style?: ViewStyle | ViewStyle[];
  children?: React.ReactNode;
}

export function Surface({
  level = 1,
  radius = "lg",
  glow = "none",
  borderColor,
  topHighlight = true,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const r = radii[radius];
  const [from, to] = GRADIENTS[level] ?? GRADIENTS[1];
  const gradId = React.useId();

  return (
    <View
      {...rest}
      style={[
        styles.base,
        { borderRadius: r, borderColor: borderColor ?? colors.hairline },
        glow !== "none" ? GLOW_SHADOW[glow] : shadows.md,
        style as ViewStyle,
      ]}
    >
      {/* Gradient fill (web + native safe via svg) */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: r, overflow: "hidden" },
        ]}
        pointerEvents="none"
      >
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={from} />
              <Stop offset="1" stopColor={to} />
            </LinearGradient>
          </Defs>
          <Rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill={`url(#${gradId})`}
          />
        </Svg>
      </View>

      {/* 1px top-edge highlight for depth */}
      {topHighlight ? (
        <View
          pointerEvents="none"
          style={[
            styles.topHighlight,
            { borderTopLeftRadius: r, borderTopRightRadius: r },
          ]}
        />
      ) : null}

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
    backgroundColor: colors.surface1, // fallback under the svg gradient
    overflow: "visible",
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
});
