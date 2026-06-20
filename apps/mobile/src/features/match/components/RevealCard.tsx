import React, { useEffect, useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, Line, Pattern, Rect } from "react-native-svg";
import { colors, radius, spacing, spring, type } from "@/theme";
import { AnimatedNumber, Pressable, Surface, Text } from "@/ui";
import { haptics } from "@/ui/haptics";
import { money, multiple, signedMoney } from "@/lib/format";
import type { RevealVM } from "@/state/types";
import { GlowWash } from "./GlowWash";

/**
 * RevealCard — the weighty tap-to-reveal moment. A bet has settled but the user
 * hasn't been spoiled yet: a striped "TAP TO REVEAL" cover sits over the result.
 * Tap → the cover does a weighty Y-flip away and the verdict lands:
 *
 * WIN → gold wordmark, payout counts up, gold glow + success haptic, and the
 * parent fires confetti + the balance count-up.
 * MISS → muted "MISSED", a brief shake, stake shown as lost, error haptic.
 * VOID → cyan "VOIDED", stake refunded, neutral.
 *
 * The parent passes `reveal` and an `onAcknowledge` (called when the cover opens,
 * which is when money is actually credited + the bet is written to history).
 */
export function RevealCard({
  reveal,
  onAcknowledge,
  hapticsEnabled = true,
}: {
  reveal: RevealVM;
  onAcknowledge: () => void;
  hapticsEnabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const flip = useSharedValue(0); // 0 = cover up, 1 = flipped away
  const shake = useSharedValue(0);
  const isWin = reveal.won;
  const isVoid = reveal.outcome === "VOID";

  const tint = isVoid ? colors.cyan : isWin ? colors.gold : colors.no;

  const open = () => {
    if (opened) return;
    setOpened(true);
    if (hapticsEnabled) {
      if (isVoid) haptics.tap();
      else if (isWin) haptics.win();
      else haptics.lose();
    }
    // credit + history happen now (the parent's acknowledgeReveal).
    onAcknowledge();
    flip.value = withTiming(1, {
      duration: 480,
      easing: Easing.inOut(Easing.cubic),
    });
    if (!isWin && !isVoid) {
      shake.value = withDelay(
        260,
        withSequence(
          withTiming(-1, { duration: 60 }),
          withRepeat(withTiming(1, { duration: 90 }), 4, true),
          withSpring(0, spring.bouncy),
        ),
      );
    }
  };

  const coverStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flip.value, [0, 0.5, 1], [1, 0.4, 0]),
    transform: [
      { perspective: 800 },
      { rotateX: `${flip.value * -100}deg` },
      { translateY: flip.value * -10 },
    ],
  }));

  const resultStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flip.value, [0.45, 1], [0, 1]),
    transform: [
      { translateX: shake.value * 9 },
      { scale: interpolate(flip.value, [0.45, 1], [0.96, 1]) },
    ],
  }));

  return (
    <Surface
      radius={radius.xl}
      // SPOILER-SAFE: stay a neutral surface until the user taps. The outcome
      // colour (gold/red/cyan glow + border) only appears once `opened`, so the
      // card edge can't give the result away while the cover is still up.
      glow={opened ? (isWin ? "gold" : isVoid ? "cyan" : "no") : undefined}
      borderColor={opened ? tint : undefined}
      style={styles.card}
    >
      {opened ? (
        <GlowWash
          color={tint}
          opacity={isWin ? 0.22 : 0.12}
          cx="50%"
          cy="46%"
          r="62%"
        />
      ) : null}

      {/* the verdict (revealed under the cover) */}
      <Animated.View style={[styles.result, resultStyle]}>
        <Text
          style={[styles.verdict, { color: tint }]}
          allowFontScaling={false}
        >
          {isVoid ? "VOIDED" : isWin ? "YOU WON" : "MISSED"}
        </Text>
        {isWin ? (
          <View style={styles.payRow}>
            <AnimatedNumber
              value={reveal.payout}
              format={(n) => signedMoney(n)}
              style={[styles.payBig, { color: colors.gold }]}
            />
            <Text style={styles.payMeta}>
              {multiple(reveal.payoutMult)} final on {money(reveal.stake)}
            </Text>
          </View>
        ) : isVoid ? (
          <Text style={styles.payMeta}>
            Unfair timing — {money(reveal.stake)} refunded in full.
          </Text>
        ) : (
          <Text style={styles.payMeta}>
            {signedMoney(-reveal.stake)} · {reveal.side} didn't land
          </Text>
        )}
      </Animated.View>

      {/* the cover */}
      {opened ? null : <RevealCover style={coverStyle} onPress={open} />}
    </Surface>
  );
}

function RevealCover({
  style,
  onPress,
}: {
  style: ReturnType<typeof useAnimatedStyle>;
  onPress: () => void;
}) {
  // gentle breathing on the prompt so it begs to be tapped
  const breathe = useSharedValue(0);
  useEffect(() => {
    breathe.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [breathe]);
  const promptStyle = useAnimatedStyle(() => ({
    opacity: interpolate(breathe.value, [0, 1], [0.7, 1]),
  }));

  // reanimated 3.16 (SDK 52) tightened AnimatedStyle so mixing static styles with
  // a useAnimatedStyle result in one array no longer unifies at the type level;
  // the runtime composition is unchanged, so cast the array.
  const coverWrapStyle = [
    StyleSheet.absoluteFill,
    styles.coverWrap,
    style,
  ] as unknown as ViewStyle;
  return (
    <Animated.View style={coverWrapStyle}>
      <Pressable
        onPress={onPress}
        haptic={null}
        scaleTo={0.985}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel="Tap to reveal your result"
      >
        <Stripes />
        <View style={styles.coverInner}>
          <Animated.View style={promptStyle}>
            <Text style={styles.coverTitle}>TAP TO REVEAL</Text>
          </Animated.View>
          {/* neutral on purpose — must not hint win/loss/void before the tap */}
          <Text style={styles.coverSub}>see how it played out</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** The 45° striped texture of the cover (matches the prototype's barber pole). */
function Stripes() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.stripesBg]}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern
            id="golazoStripes"
            width={20}
            height={20}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <Rect width={20} height={20} fill={colors.surface1} />
            <Line
              x1={0}
              y1={0}
              x2={0}
              y2={20}
              stroke={colors.surface2}
              strokeWidth={10}
            />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#golazoStripes)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { minHeight: 116, justifyContent: "center", overflow: "hidden" },
  result: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.lg,
  },
  verdict: { ...type.display, fontSize: 26, letterSpacing: 1 },
  payRow: { alignItems: "center", gap: 2 },
  payBig: { ...type.mono, fontSize: 24 },
  payMeta: { ...type.caption, fontSize: 12.5, color: colors.textMuted },
  coverWrap: { borderRadius: radius.xl, overflow: "hidden" },
  stripesBg: { borderRadius: radius.xl, overflow: "hidden" },
  coverInner: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  coverTitle: {
    ...type.display,
    fontSize: 18,
    letterSpacing: 2,
    color: colors.textPrimary,
  },
  coverSub: { ...type.caption, fontSize: 11, color: colors.textMuted },
});
