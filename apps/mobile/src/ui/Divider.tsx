import React from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, spacing, type } from "@/theme";

/**
 * Divider — a 1px hairline separator. Optionally with a centered label
 * (an "OR"-style rule) for sectioning sheets and forms.
 *
 * @param label    optional centered overline label.
 * @param spacing  vertical margin around the rule (default spacing.lg).
 * @param inset    horizontal inset so it doesn't run edge-to-edge.
 */
export function Divider({
  label,
  margin = spacing.lg,
  inset = 0,
  style,
}: {
  label?: string;
  margin?: number;
  inset?: number;
  style?: ViewStyle;
}) {
  if (label) {
    return (
      <View
        style={[
          styles.labeled,
          { marginVertical: margin, marginHorizontal: inset },
          style,
        ]}
      >
        <View style={styles.line} />
        <Text style={[type.overline, styles.label]}>{label}</Text>
        <View style={styles.line} />
      </View>
    );
  }
  return (
    <View
      style={[
        styles.rule,
        { marginVertical: margin, marginHorizontal: inset },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
  labeled: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
  },
  label: { color: colors.textFaint },
});
