import React, { useEffect } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  colors,
  duration,
  radius as radii,
  spacing,
  type as typePresets,
} from "@/theme";
import { Pressable } from "./Pressable";

/**
 * Chip / Pill — a compact rounded label. Two jobs:
 *   1. Status chip: a small token (mode, phase, "LIVE", outcome). With `dot` it
 *      shows a pulsing status dot — the signature live-pulse used on LIVE markets.
 *   2. Selectable chip: pass `onPress`/`selected` to make it a toggle (e.g. the
 *      stake presets, filter chips). Gets press-depth + a selected tint.
 *
 * Tones map to the palette: 'live' (lime), 'info' (cyan), 'win' (gold),
 * 'danger' (red), 'neutral' (muted). The tone colors the dot/border/selected
 * fill so a chip reads at a glance.
 */
export type ChipTone = "live" | "info" | "win" | "danger" | "neutral";

const TONE: Record<
  ChipTone,
  { fg: string; dot: string; fill: string; border: string }
> = {
  live: {
    fg: colors.yes,
    dot: colors.yes,
    fill: colors.alpha.yes,
    border: colors.glow.yesSoft,
  },
  info: {
    fg: colors.cyan,
    dot: colors.cyan,
    fill: colors.alpha.cyan,
    border: colors.glow.cyanSoft,
  },
  win: {
    fg: colors.gold,
    dot: colors.gold,
    fill: colors.alpha.gold,
    border: colors.glow.goldSoft,
  },
  danger: {
    fg: colors.no,
    dot: colors.no,
    fill: colors.alpha.no,
    border: colors.glow.noSoft,
  },
  neutral: {
    fg: colors.textMuted,
    dot: colors.textMuted,
    fill: colors.alpha.white06,
    border: colors.hairline,
  },
};

/** A small dot that gently pulses (opacity + scale). Used on LIVE chips. */
function PulseDot({ color }: { color: string }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withRepeat(
      withSequence(
        withTiming(1, { duration: duration.dot }),
        withTiming(0, { duration: duration.dot }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(v);
  }, [v]);
  const ring = useAnimatedStyle(() => ({
    opacity: 0.5 - v.value * 0.5,
    transform: [{ scale: 1 + v.value * 1.6 }],
  }));
  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[styles.dotRing, { backgroundColor: color }, ring]}
        pointerEvents="none"
      />
      <View style={[styles.dotCore, { backgroundColor: color }]} />
    </View>
  );
}

export function Chip({
  label,
  tone = "neutral",
  dot = false,
  selected = false,
  onPress,
  left,
  style,
}: {
  label: string;
  tone?: ChipTone;
  /** Show the pulsing status dot (e.g. LIVE). */
  dot?: boolean;
  /** Selected (toggle) state — fills with the tone color. */
  selected?: boolean;
  onPress?: () => void;
  left?: React.ReactNode;
  style?: ViewStyle;
}) {
  const t = TONE[tone];
  // SELECTED must read clearly + legibly for EVERY tone. The old style used the
  // tone's faint fill + tone-colored text, which for `neutral` was identical to
  // the unselected look (and for accents was low-contrast colour-on-colour). Now:
  // selected = bright white text on a solid surface with a tone border; unselected
  // = muted text on a faint fill. Status chips (dot) keep their tone-coloured text.
  const body = (
    <View
      style={[
        styles.base,
        {
          backgroundColor: selected ? colors.surface2 : colors.alpha.white06,
          borderColor: selected || dot ? t.border : colors.hairline,
        },
        style,
      ]}
    >
      {dot ? <PulseDot color={t.dot} /> : null}
      {left}
      <Text
        style={[
          typePresets.overline,
          styles.label,
          {
            color: selected
              ? colors.textPrimary
              : dot
                ? t.fg
                : colors.textMuted,
          },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} scaleTo={0.94} haptic="selection">
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  label: { letterSpacing: 1 },
  dotWrap: {
    width: 8,
    height: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  dotRing: { position: "absolute", width: 8, height: 8, borderRadius: 4 },
  dotCore: { width: 6, height: 6, borderRadius: 3 },
});
