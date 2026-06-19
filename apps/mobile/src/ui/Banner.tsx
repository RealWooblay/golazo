import React from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, radius as radii, spacing, type } from "@/theme";
import type { ToastTone } from "./Toast";

const TONE: Record<ToastTone, { fg: string; fill: string; border: string }> = {
  info: {
    fg: colors.cyan,
    fill: colors.alpha.cyan,
    border: colors.glow.cyanSoft,
  },
  success: {
    fg: colors.yes,
    fill: colors.alpha.yes,
    border: colors.glow.yesSoft,
  },
  danger: { fg: colors.no, fill: colors.alpha.no, border: colors.glow.noSoft },
  gold: {
    fg: colors.gold,
    fill: colors.alpha.gold,
    border: colors.glow.goldSoft,
  },
};

/**
 * Banner — an INLINE, persistent notice (vs the transient {@link Toast}). Used
 * for the live→offline fallback notice, a "sandbox / play money" reminder, a
 * deposit-pending strip. Tinted by tone, with an optional title + body.
 */
export function Banner({
  tone = "info",
  title,
  message,
  left,
  right,
  style,
}: {
  tone?: ToastTone;
  title?: string;
  message: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  const t = TONE[tone];
  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.fill, borderColor: t.border },
        style,
      ]}
    >
      {left ? <View style={styles.side}>{left}</View> : null}
      <View style={styles.body}>
        {title ? (
          <Text style={[type.overline, { color: t.fg }]}>{title}</Text>
        ) : null}
        <Text style={[type.caption, styles.message]}>{message}</Text>
      </View>
      {right ? <View style={styles.side}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  side: { alignItems: "center", justifyContent: "center" },
  body: { flex: 1, gap: 2 },
  message: { color: colors.textSecondary },
});
