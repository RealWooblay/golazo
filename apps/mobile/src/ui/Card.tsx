import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { spacing } from "@/theme";
import { Pressable } from "./Pressable";
import { Surface, type GlowKind } from "./Surface";

/**
 * Card — a {@link Surface} with standard inner padding, and (optionally) tappable
 * with the shared press-depth. Use it for content rows, list items, lobby
 * fixtures, profile cards — anything that needs the layered look + comfortable
 * gutter without re-deriving padding each time.
 *
 * If `onPress` is provided the whole card becomes a Pressable (spring depth +
 * haptic). Otherwise it's a static Surface.
 */
export function Card({
  children,
  style,
  onPress,
  padding = spacing.lg,
  radius,
  elevated,
  glow,
  borderColor,
  disabled,
}: {
  children?: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  onPress?: () => void;
  padding?: number;
  radius?: number;
  elevated?: boolean;
  glow?: GlowKind;
  borderColor?: string;
  disabled?: boolean;
}) {
  const surface = (
    <Surface
      radius={radius}
      elevated={elevated}
      glow={glow}
      borderColor={borderColor}
      style={[{ padding }, style as ViewStyle]}
    >
      {children}
    </Surface>
  );

  if (!onPress) return surface;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      scaleTo={0.98}
      haptic="tap"
      style={styles.wrap}
    >
      {surface}
    </Pressable>
  );
}

const styles = StyleSheet.create({ wrap: { width: "100%" } });
