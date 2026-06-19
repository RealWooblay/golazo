import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors, radius as radii } from "@/theme";
import { Pressable } from "./Pressable";
import type { HapticName } from "./haptics";

/**
 * IconButton — a compact, circular/rounded tappable for a single glyph (back,
 * close, settings, sound toggle). Composes the shared press-depth + haptic.
 *
 * Bring your own icon as children (an SVG, an Image, or a Text glyph). Variants
 * control the chrome:
 *   • surface — subtle filled chip on a hairline (default).
 *   • ghost   — transparent, no border (for over-content placement).
 *
 * @param size  diameter in px (default 40). Always a comfortable touch target.
 */
export function IconButton({
  children,
  onPress,
  size = 40,
  variant = "surface",
  haptic = "tap",
  disabled,
  style,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  size?: number;
  variant?: "surface" | "ghost";
  haptic?: HapticName | null;
  disabled?: boolean;
  style?: ViewStyle | ViewStyle[];
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      haptic={haptic}
      scaleTo={0.9}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.base,
        { width: size, height: size, borderRadius: radii.pill },
        variant === "surface" && styles.surface,
        style,
      ]}
    >
      <View style={styles.center}>{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center" },
  surface: {
    backgroundColor: colors.alpha.white06,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  center: { alignItems: "center", justifyContent: "center" },
});
