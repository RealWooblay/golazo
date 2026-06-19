import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import {
  AnimatedNumber,
  Button,
  Chip,
  IconArrowUp,
  IconPlus,
  Text,
} from "@/ui";
import { colors, duration, radius, spacing, type } from "@/theme";
import { money } from "@/lib/format";
import { Surface } from "./Surface";

/**
 * WalletHero — the centrepiece of the Wallet tab. A tall, glowing card with the
 * play-money balance rendered HUGE and animated (count-up on credit / down on
 * withdraw), a soft lime radial bloom behind the number, a live "play balance"
 * eyebrow, a streak/promo chip, and the two primary money CTAs (Add cash /
 * Cash out).
 *
 * Everything money flows through the store; this component is presentational —
 * it just takes the current balance + handlers. The glow + bloom are surgical
 * (this is the one hero moment on the screen), built from SVG so it's web-safe.
 */
export interface WalletHeroProps {
  balance: number;
  /** A short streak / promo line, e.g. "3-day streak · +5% boost". */
  flair?: string;
  /** Tap "Add cash" → open the deposit modal. */
  onAddCash: () => void;
  /** Tap "Cash out" → open the withdraw modal. Disabled at $0. */
  onCashOut: () => void;
  /** Disable the cash-out CTA (e.g. zero balance). */
  cashOutDisabled?: boolean;
}

export function WalletHero({
  balance,
  flair,
  onAddCash,
  onCashOut,
  cashOutDisabled,
}: WalletHeroProps) {
  // Gentle breathing on the bloom so the hero feels alive without distracting.
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2600 }),
        withTiming(0, { duration: 2600 }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const bloom = useAnimatedStyle(() => ({
    opacity: 0.55 + pulse.value * 0.35,
  }));

  return (
    <Surface level={2} radius="xl" glow="yes" style={styles.card}>
      {/* Lime radial bloom behind the balance */}
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.bloomWrap, bloom]}
        pointerEvents="none"
      >
        <Svg width="100%" height="100%">
          <Defs>
            <RadialGradient id="walletBloom" cx="50%" cy="34%" r="62%">
              <Stop offset="0" stopColor={colors.yes} stopOpacity={0.22} />
              <Stop offset="0.55" stopColor={colors.yes} stopOpacity={0.06} />
              <Stop offset="1" stopColor={colors.yes} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="url(#walletBloom)"
          />
        </Svg>
      </Animated.View>

      <View style={styles.head}>
        <Chip label="Play balance" tone="live" dot />
        {flair ? (
          <Text style={[type.caption, styles.flair]}>{flair}</Text>
        ) : null}
      </View>

      <AnimatedNumber
        value={balance}
        format={money}
        style={[type.hero, styles.balance]}
      />
      <Text style={[type.caption, styles.sub]}>
        Ready to play · settles instantly
      </Text>

      <View style={styles.ctas}>
        <Button
          label="Add cash"
          onPress={onAddCash}
          variant="primary"
          size="lg"
          fullWidth
          glow
          left={<IconPlus size={20} color={colors.onPrimary} />}
          style={styles.cta}
        />
        <Button
          label="Cash out"
          onPress={onCashOut}
          variant="ghost"
          size="lg"
          fullWidth
          disabled={cashOutDisabled}
          left={
            <IconArrowUp
              size={20}
              color={cashOutDisabled ? colors.textFaint : colors.textPrimary}
            />
          }
          style={styles.cta}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.xl, paddingTop: spacing.xl, overflow: "hidden" },
  bloomWrap: { borderRadius: radius.xl },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  flair: { color: colors.gold, flexShrink: 1, textAlign: "right" },
  balance: {
    color: colors.textPrimary,
    marginTop: spacing.lg,
    fontSize: 52,
    lineHeight: 56,
  },
  sub: { color: colors.textMuted, marginTop: spacing.xs },
  ctas: { flexDirection: "row", gap: spacing.md, marginTop: spacing.xl },
  cta: { flex: 1 },
});
