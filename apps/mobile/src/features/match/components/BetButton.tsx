import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, shadows, type } from "@/theme";
import { Pressable, AnimatedNumber, Text } from "@/ui";
import { multiple } from "@/lib/format";

/**
 * BetButton — the big, clear YES / NO action. Two-line: the verdict word on top,
 * the live (animated) indicative multiple below. A FLAT solid fill (no gloss/gradient),
 * spring press-depth + a weighty haptic, a whisper of colored edge when active, and a
 * clean disabled state once a bet is in or the window closes.
 *
 * The odds ticker uses AnimatedNumber so the estimate visibly drifts as the pool moves.
 */
export function BetButton({
  side,
  odds,
  label,
  onPress,
  disabled,
  /** Dim everything except the side the user just picked. */
  picked,
}: {
  side: "YES" | "NO";
  odds: number;
  /** The honest verdict word — "Shot" / "No shot" / "Scores" / "Goal" — derived from
   *  the market kind. Falls back to the raw side. */
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  picked?: "YES" | "NO" | null;
}) {
  const isYes = side === "YES";
  // Flat solid fill — no gradient gloss.
  const solid = isYes ? colors.raw.lime : colors.raw.red;
  const fg = isYes ? colors.onYes : "#ffffff";

  // When a pick is in, the chosen side stays lit, the other goes flat.
  const dimmed = picked != null && picked !== side;
  const glow = !disabled || picked === side;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      haptic={isYes ? "select" : "heavy"}
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityLabel={`Bet ${side}, estimated ${multiple(odds)}`}
      accessibilityState={{ disabled: !!disabled }}
      style={[
        styles.btn,
        { backgroundColor: solid },
        glow ? (isYes ? shadows.glowYes : shadows.glowNo) : null,
        dimmed && styles.dimmed,
      ]}
    >
      <Text
        style={[styles.word, styles.content, { color: fg }]}
        allowFontScaling={false}
        numberOfLines={1}
      >
        {label ?? side}
      </Text>
      <View style={[styles.oddsRow, styles.content]}>
        <AnimatedNumber
          value={odds}
          format={multiple}
          style={[styles.odds, { color: fg }]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flex: 1,
    height: 72,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  clip: { borderRadius: radius.lg, overflow: "hidden", zIndex: 0 },
  content: { zIndex: 1 },
  dimmed: { opacity: 0.4 },
  word: { ...type.display, fontSize: 22, letterSpacing: 1 },
  oddsRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 1,
  },
  odds: { ...type.mono, fontSize: 14, fontWeight: "700" },
  sub: { ...type.caption, fontSize: 11, opacity: 0.85 },
});
