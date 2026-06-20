import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, radius as radii, shadows, spacing, type } from "@/theme";
import { Pressable } from "./Pressable";
import type { HapticName } from "./haptics";

/**
 * Button — the primary action primitive.
 *
 * Variants:
 *   • primary   — lime gradient, dark text, lime glow. The main CTA / YES.
 *   • secondary — cyan gradient, dark text, cyan glow. Info / alt action.
 *   • danger    — red gradient, white text, red glow. NO / destructive.
 *   • ghost     — transparent w/ hairline border, light text. Tertiary action.
 *
 * Every variant gets the shared spring press-DEPTH + a haptic on press-in
 * ('select' by default for the committal feel). Filled variants render a vertical
 * gradient via react-native-svg (web-safe). `glow` is ON by default for filled
 * variants (used on the live CTA) — set glow={false} to mute it in dense lists.
 *
 * Sizes: sm | md (default) | lg. `fullWidth` stretches to the container.
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** Show the colored glow halo (default true for filled variants). */
  glow?: boolean;
  /** Haptic fired on press-in. Default 'select'. Pass null to silence. */
  haptic?: HapticName | null;
  /** Optional leading element (icon). */
  left?: React.ReactNode;
  /** Optional trailing element. */
  right?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}

const GRADIENTS: Record<
  Exclude<ButtonVariant, "ghost">,
  readonly [string, string]
> = {
  primary: [colors.raw.limeBright, colors.raw.limeDeep],
  secondary: [colors.raw.cyan, colors.raw.cyanDeep],
  danger: [colors.raw.redBright, colors.raw.redDeep],
};

/**
 * Solid fill fallback per variant. The SVG gradient is a nicety layered on top;
 * this guarantees the button is ALWAYS visible (with correct text contrast) even
 * if the gradient SVG fails to paint — which it can on React Native Web (a
 * percentage-sized <Svg> resolving to 0 on first layout, or an id collision).
 * Without this the filled buttons render transparent and their near-black label
 * vanishes on the dark background.
 */
const SOLID_FILL: Record<Exclude<ButtonVariant, "ghost">, string> = {
  primary: colors.raw.lime,
  secondary: colors.raw.cyan,
  danger: colors.raw.red,
};

const TEXT_ON: Record<ButtonVariant, string> = {
  primary: colors.onPrimary,
  secondary: colors.raw.onLime,
  danger: "#ffffff",
  ghost: colors.textPrimary,
};

const SIZES: Record<ButtonSize, { h: number; px: number; font: number }> = {
  sm: { h: 38, px: spacing.lg, font: 14 },
  md: { h: 50, px: spacing.xl, font: 16 },
  lg: { h: 58, px: spacing.xxl, font: 18 },
};

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  fullWidth = false,
  glow,
  haptic = "select",
  left,
  right,
  style,
}: ButtonProps) {
  const sz = SIZES[size];
  const isGhost = variant === "ghost";
  // Unique per-instance gradient id — React.useId() can contain ':' which is
  // invalid in an SVG id / url(#…), so strip it.
  const gradId = `uiBtn-${variant}-${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const showGlow = (glow ?? !isGhost) && !disabled;
  const glowShadow =
    variant === "primary"
      ? shadows.glowYes
      : variant === "secondary"
        ? shadows.glowCyan
        : variant === "danger"
          ? shadows.glowNo
          : undefined;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      haptic={haptic}
      scaleTo={0.95}
      accessibilityState={{ disabled: disabled || loading }}
      style={[
        styles.base,
        { height: sz.h, paddingHorizontal: sz.px, borderRadius: radii.md },
        // Solid fill fallback so the button is never invisible if the SVG
        // gradient fails to paint (RN-Web). The gradient layers on top.
        !isGhost && { backgroundColor: SOLID_FILL[variant] },
        fullWidth && styles.fullWidth,
        isGhost && styles.ghost,
        showGlow && glowShadow,
        style,
      ]}
    >
      {!isGhost ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: radii.md, overflow: "hidden", zIndex: 0 },
          ]}
          pointerEvents="none"
        >
          {/* viewBox + preserveAspectRatio="none" makes the fill independent of
              pixel sizing, so it reliably covers the button on web (a plain
              width/height="100%" SVG can resolve to 0 on first layout). */}
          <Svg
            width="100%"
            height="100%"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            <Defs>
              <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={GRADIENTS[variant][0]} />
                <Stop offset="1" stopColor={GRADIENTS[variant][1]} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="1" height="1" fill={`url(#${gradId})`} />
          </Svg>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={TEXT_ON[variant]} />
      ) : (
        <View style={[styles.row, styles.content]}>
          {left}
          <Text
            numberOfLines={1}
            style={[
              type.subtitle,
              styles.label,
              { fontSize: sz.font, color: TEXT_ON[variant] },
            ]}
          >
            {label}
          </Text>
          {right}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  fullWidth: { alignSelf: "stretch", width: "100%" },
  ghost: {
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.alpha.white06,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // Keep the label above the gradient fill (positioned siblings paint over
  // in-flow content on web regardless of DOM order).
  content: { zIndex: 1 },
  label: { letterSpacing: 0.2 },
});
