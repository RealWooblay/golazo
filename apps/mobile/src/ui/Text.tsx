import React from "react";
import {
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from "react-native";
import { colors, type as typePresets, type TypePreset } from "@/theme";

/**
 * Text — a thin convenience over RN <Text> that applies a `type.*` preset by name
 * and a default color, so screens read declaratively:
 *
 *   <Text preset="title">Argentina on the attack</Text>
 *   <Text preset="mono" color={colors.yes}>3.48x</Text>
 *
 * Optional `muted` / `color` shortcuts. Falls through all RN Text props
 * (numberOfLines, onPress, etc.). Use raw <Text> from RN only for one-offs.
 */
export interface TextProps extends RNTextProps {
  preset?: TypePreset;
  color?: string;
  muted?: boolean;
  faint?: boolean;
  center?: boolean;
  children?: React.ReactNode;
}

export function Text({
  preset = "body",
  color,
  muted,
  faint,
  center,
  style,
  children,
  ...rest
}: TextProps) {
  const resolved =
    color ??
    (faint ? colors.textFaint : muted ? colors.textMuted : colors.textPrimary);
  const base: TextStyle = {
    ...typePresets[preset],
    color: resolved,
    ...(center ? { textAlign: "center" } : null),
  };
  return (
    <RNText style={[base, style]} {...rest}>
      {children}
    </RNText>
  );
}
