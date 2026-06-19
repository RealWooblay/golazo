import React from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, spacing, type } from "@/theme";
import { Button } from "./Button";

/**
 * EmptyState — a thoughtful "nothing here yet" panel with personality, not a bare
 * gray box. Used for an empty bet history, no live matches, an empty wallet
 * ledger. A big glyph/emoji, a punchy title, supporting copy, and an optional CTA.
 *
 * Keep the copy on-brand (a little degen, never apologetic). Examples:
 *   title "No moments yet"  body "The next attack opens a market. Stay sharp."
 *   title "Dry wallet"      body "Top up to get in the game." cta "Deposit"
 */
export function EmptyState({
  icon,
  title,
  body,
  ctaLabel,
  onCta,
  style,
}: {
  /** A glyph/emoji string or any node (an SVG illustration). */
  icon?: React.ReactNode;
  title: string;
  body?: string;
  ctaLabel?: string;
  onCta?: () => void;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.root, style]}>
      {icon ? (
        typeof icon === "string" ? (
          <Text style={styles.icon}>{icon}</Text>
        ) : (
          <View style={styles.iconWrap}>{icon}</View>
        )
      ) : null}
      <Text style={[type.title, styles.title]}>{title}</Text>
      {body ? <Text style={[type.body, styles.body]}>{body}</Text> : null}
      {ctaLabel && onCta ? (
        <Button
          label={ctaLabel}
          onPress={onCta}
          variant="primary"
          size="md"
          style={styles.cta}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.huge,
    gap: spacing.sm,
  },
  icon: { fontSize: 44, marginBottom: spacing.xs, opacity: 0.85 },
  iconWrap: { marginBottom: spacing.sm },
  title: { color: colors.textPrimary, textAlign: "center" },
  body: { color: colors.textMuted, textAlign: "center", maxWidth: 280 },
  cta: { marginTop: spacing.md },
});
