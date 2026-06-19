import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, spacing } from "@/theme";
import { Screen } from "./Screen";
import { Card } from "./Card";
import { Chip, type ChipTone } from "./Chip";
import { Text } from "./Text";
import { SkeletonGroup, Skeleton } from "./Skeleton";

const TINT_TO_TONE: Record<string, ChipTone> = {
  yes: "live",
  no: "danger",
  gold: "win",
  cyan: "info",
  neutral: "neutral",
};

/**
 * StubScreen — a themed, premium placeholder a feature agent replaces. It already
 * reads on-brand (canvas, vignette, a layered card, a status chip, skeletons) so
 * the navigation shell looks finished in screenshots before the real screens land.
 *
 * Each route stub passes its title + the owning agent so it's unmistakable who
 * fills it in. NOT a gray rectangle — it's the design language, just empty.
 */
export function StubScreen({
  title,
  owner,
  blurb,
  tint = "cyan",
}: {
  title: string;
  owner: string;
  blurb?: string;
  tint?: "yes" | "no" | "gold" | "cyan" | "neutral";
}) {
  return (
    <Screen vignette={tint}>
      <View style={styles.head}>
        <Chip label="Coming together" tone={TINT_TO_TONE[tint] ?? "info"} dot />
        <Text preset="hero" style={styles.title}>
          {title}
        </Text>
        {blurb ? (
          <Text preset="body" muted>
            {blurb}
          </Text>
        ) : null}
      </View>

      <Card style={styles.card}>
        <Skeleton width="55%" height={20} />
        <View style={{ height: spacing.md }} />
        <SkeletonGroup lines={3} />
      </Card>

      <Card elevated style={styles.card}>
        <Skeleton width="40%" height={16} />
        <View style={{ height: spacing.md }} />
        <SkeletonGroup lines={2} lastLineWidth="45%" />
      </Card>

      <Text preset="caption" faint center style={styles.owner}>
        OWNED BY: {owner}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: spacing.sm, marginBottom: spacing.xl, alignItems: "flex-start" },
  title: { color: colors.textPrimary },
  card: { gap: spacing.xs, marginBottom: spacing.lg },
  owner: { marginTop: spacing.lg },
});
