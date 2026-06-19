import React from "react";
import { StyleSheet, View } from "react-native";
import { Pressable, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { Surface } from "./Surface";

/**
 * MethodOption — a selectable payment-method row (card / Apple Pay / crypto /
 * bank / saved wallet). A leading glyph in a tinted disc, a title + subtitle, an
 * optional trailing tag ("Instant", "Demo"), and a selection ring. Built on the
 * wallet Surface so the depth matches the rest of the screen; tapping springs +
 * fires a selection haptic.
 *
 * Generic enough for both the deposit method picker and the withdraw destination
 * picker — the parent owns the selected id and passes `selected`.
 */
export type MethodTint = "yes" | "cyan" | "gold" | "neutral";

const RING: Record<MethodTint, string> = {
  yes: colors.glow.yesSoft,
  cyan: colors.glow.cyanSoft,
  gold: colors.glow.goldSoft,
  neutral: colors.hairline,
};
const DISC: Record<MethodTint, string> = {
  yes: colors.alpha.yes,
  cyan: colors.alpha.cyan,
  gold: colors.alpha.gold,
  neutral: colors.alpha.white06,
};
const FG: Record<MethodTint, string> = {
  yes: colors.yes,
  cyan: colors.cyan,
  gold: colors.gold,
  neutral: colors.textMuted,
};

export interface MethodOptionProps {
  /** Emoji or node for the leading disc. */
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  /** Trailing tag, e.g. "Instant" / "Demo". */
  tag?: string;
  tint?: MethodTint;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function MethodOption({
  icon,
  title,
  subtitle,
  tag,
  tint = "cyan",
  selected = false,
  disabled = false,
  onPress,
}: MethodOptionProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      haptic="selection"
      scaleTo={0.98}
    >
      <Surface
        level={selected ? 2 : 1}
        radius="lg"
        borderColor={selected ? RING[tint] : colors.hairline}
        glow={selected ? (tint === "neutral" ? "none" : tint) : "none"}
        style={disabled ? [styles.card, styles.disabled] : styles.card}
      >
        <View style={[styles.disc, { backgroundColor: DISC[tint] }]}>
          {typeof icon === "string" ? (
            <Text style={styles.iconText}>{icon}</Text>
          ) : (
            icon
          )}
        </View>

        <View style={styles.body}>
          <Text style={[type.bodyStrong, styles.title]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[type.caption, styles.subtitle]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {tag ? (
          <View style={[styles.tag, { borderColor: RING[tint] }]}>
            <Text style={[type.overline, { color: FG[tint] }]}>{tag}</Text>
          </View>
        ) : null}

        <View style={[styles.radio, selected && { borderColor: FG[tint] }]}>
          {selected ? (
            <View style={[styles.radioDot, { backgroundColor: FG[tint] }]} />
          ) : null}
        </View>
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
  },
  disabled: { opacity: 0.45 },
  disc: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { fontSize: 20 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary },
  subtitle: { color: colors.textMuted },
  tag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
