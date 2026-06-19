import React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, radius, shadows, type } from "@/theme";
import { Pressable, AnimatedNumber, Text } from "@/ui";
import { multiple } from "@/lib/format";

/**
 * BetButton — the big, juicy YES / NO action. Two-line: the verdict word on top,
 * the live (animated) indicative multiple below it. Full SVG gradient fill (matches
 * the Button primitive), spring press-depth + a weighty haptic from @/ui Pressable,
 * a colored glow when active, and a clean disabled state once a bet is in or the
 * window closes.
 *
 * The odds ticker uses AnimatedNumber so the estimate visibly drifts as the pool
 * moves.
 */
export function BetButton({
  side,
  odds,
  sublabel,
  onPress,
  disabled,
  /** Dim everything except the side the user just picked. */
  picked,
}: {
  side: "YES" | "NO";
  odds: number;
  sublabel: string;
  onPress: () => void;
  disabled?: boolean;
  picked?: "YES" | "NO" | null;
}) {
  const isYes = side === "YES";
  const grad = isYes
    ? [colors.raw.limeBright, colors.raw.limeDeep]
    : [colors.raw.redBright, colors.raw.redDeep];
  const fg = isYes ? colors.onYes : "#ffffff";
  const id = `betbtn-${side}`;

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
        glow ? (isYes ? shadows.glowYes : shadows.glowNo) : null,
        dimmed && styles.dimmed,
      ]}
    >
      <View style={[StyleSheet.absoluteFill, styles.clip]}>
        <Svg width="100%" height="100%" pointerEvents="none">
          <Defs>
            <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={grad[0]} />
              <Stop offset="1" stopColor={grad[1]} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${id})`} />
        </Svg>
      </View>

      <Text style={[styles.word, { color: fg }]} allowFontScaling={false}>
        {side}
      </Text>
      <View style={styles.oddsRow}>
        <AnimatedNumber
          value={odds}
          format={multiple}
          style={[styles.odds, { color: fg }]}
        />
        <Text style={[styles.sub, { color: fg }]} numberOfLines={1}>
          {sublabel}
        </Text>
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
  clip: { borderRadius: radius.lg, overflow: "hidden" },
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
