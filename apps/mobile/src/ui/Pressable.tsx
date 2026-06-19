import React, { useCallback } from "react";
import {
  Pressable as RNPressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { spring } from "@/theme";
import { haptics, type HapticName } from "./haptics";

const AnimatedRNPressable = Animated.createAnimatedComponent(RNPressable);

/**
 * Pressable — the canonical tappable for the WHOLE app. Every interactive
 * primitive (Button, IconButton, Chip, Card-when-pressable) composes this so the
 * tactile feel is identical everywhere: a spring press-DEPTH (scale-down on
 * press-in, spring-back on release) plus an optional haptic on press-in.
 *
 * Drop-in for RN's Pressable. Extra knobs:
 *   • scaleTo         — press depth (default 0.96; use 0.94 for big buttons).
 *   • haptic          — named haptic fired on press-IN ('tap' default; null = off).
 *   • enabledHaptics  — gate haptics on the user's preference (store.session).
 *
 * NB: there is a near-identical copy under features/match (kept for the match
 * loop's local imports). This is the shared, app-wide one — import from '@/ui'.
 */
export interface PressableDepthProps extends Omit<PressableProps, "style"> {
  scaleTo?: number;
  haptic?: HapticName | null;
  enabledHaptics?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Pressable({
  scaleTo = 0.96,
  haptic = "tap",
  enabledHaptics = true,
  style,
  onPressIn,
  onPressOut,
  disabled,
  children,
  ...rest
}: PressableDepthProps) {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: withSpring(pressed.value === 1 ? scaleTo : 1, spring.press) },
    ],
    opacity: withSpring(disabled ? 0.5 : 1, spring.press),
  }));

  const handleIn = useCallback<NonNullable<PressableProps["onPressIn"]>>(
    (e) => {
      pressed.value = 1;
      if (haptic && enabledHaptics && !disabled) haptics[haptic]();
      onPressIn?.(e);
    },
    [pressed, haptic, enabledHaptics, disabled, onPressIn],
  );

  const handleOut = useCallback<NonNullable<PressableProps["onPressOut"]>>(
    (e) => {
      pressed.value = 0;
      onPressOut?.(e);
    },
    [pressed, onPressOut],
  );

  return (
    <AnimatedRNPressable
      accessibilityRole="button"
      {...rest}
      disabled={disabled}
      onPressIn={handleIn}
      onPressOut={handleOut}
      style={[style, animatedStyle]}
    >
      {children}
    </AnimatedRNPressable>
  );
}
