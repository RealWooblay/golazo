import React from "react";
import { StyleSheet, View, type TextStyle, type ViewStyle } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "./Text";
import { Pressable } from "./Pressable";

/**
 * GOLAZO shared UI kit — the small set of primitives EVERY screen composes from, so the
 * whole app speaks one minimal visual language: flat surfaces, a single accent splash via
 * the lane chip, tiny quiet overline labels, bold tabular numbers.
 *
 * The rules (from the design-system unification):
 *  - lane-chip fill is ALWAYS withAlpha(tone, 0.14); icon pills use 0.12.
 *  - overlines have exactly two weights: 8pt section headers (faint) and 10pt eyebrows.
 *  - all numbers are type.mono / type.display (Space Grotesk, tabular) — never Menlo.
 *  - section headers are textFaint and neutral; tone colour lives only on lane chips
 *    and active eyebrows (LIVE / UP NEXT).
 */

/** #RRGGBB → rgba() at the given alpha (the canonical tint helper). */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** The card's single splash of colour: a small filled pill, accent@14% bg, accent text. */
export function LaneChip({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.laneChip, { backgroundColor: withAlpha(color, 0.14) }]}>
      <Text style={[type.overline, { fontSize: 10, letterSpacing: 0.8, color }]}>{label}</Text>
    </View>
  );
}

/** Tiny quiet structural label. 8pt = section header (faint), 10pt = lane/eyebrow. */
export function Overline({
  children,
  size = 8,
  color = colors.textFaint,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: TextStyle;
}) {
  return <Text style={[type.overline, { fontSize: size, color }, style]}>{children}</Text>;
}

/** Any number that isn't the hero — Space Grotesk, tabular. Default faint. */
export function MonoStat({
  children,
  size = 13,
  color = colors.textFaint,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: TextStyle;
}) {
  return <Text style={[type.mono, { fontSize: size, color }, style]}>{children}</Text>;
}

/** A label-over-number stack for grids and hero meta. */
export function StatCell({
  label,
  value,
  size = 22,
  color = colors.textPrimary,
  align = "flex-start",
}: {
  label: string;
  value: React.ReactNode;
  size?: number;
  color?: string;
  align?: "flex-start" | "flex-end" | "center";
}) {
  return (
    <View style={{ alignItems: align }}>
      <Overline size={8}>{label}</Overline>
      <MonoStat size={size} color={color} style={{ marginTop: 3 }}>
        {value}
      </MonoStat>
    </View>
  );
}

/** Outcome marker — a filled pill with on-colour text (YES / NO / VOID / team abbr). */
export function MiniBadge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[type.overline, { fontSize: 8, letterSpacing: 0.6, color: fg }]}>{label}</Text>
    </View>
  );
}

/** Circular glyph holder (distinct from the lane chip): a tinted disc at 12% bg. */
export function IconPill({
  size = 32,
  color,
  children,
}: {
  size?: number;
  color: string;
  children?: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.iconPill,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: withAlpha(color, 0.12) },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The horizontal list-row primitive: a flat surface row. `accent` adds a 2px left stripe
 * (win/loss/leader); `faint` drops to the lowest surface for dense nested strips.
 */
export function FlatRow({
  children,
  accent,
  faint = false,
  compact = false,
  onPress,
  style,
}: {
  children: React.ReactNode;
  accent?: string;
  faint?: boolean;
  compact?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const inner = (
    <View
      style={[
        styles.row,
        compact ? styles.rowCompact : null,
        { backgroundColor: faint ? colors.surface0 : colors.surface1 },
        style,
      ]}
    >
      {accent ? <View style={[styles.accentStripe, { backgroundColor: accent }]} /> : null}
      {children}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} scaleTo={0.99} haptic="tap">
        {inner}
      </Pressable>
    );
  }
  return inner;
}

const styles = StyleSheet.create({
  laneChip: { borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 3, alignSelf: "flex-start" },
  badge: { borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2.5, alignSelf: "flex-start" },
  iconPill: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
  },
  rowCompact: { paddingVertical: spacing.sm },
  accentStripe: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2 },
});
