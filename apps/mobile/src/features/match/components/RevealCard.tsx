import React, { useEffect, useState } from "react";
import { Linking, StyleSheet, View, type ViewStyle } from "react-native";
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
import { multiple } from "@/lib/format";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import type { RevealVM } from "@/state/types";
import { sideDisplayLabel } from "../marketMeta";
import { GlowWash } from "./GlowWash";

/**
 * RevealCard — tap-to-reveal for a settled bet. On-chain USX bets also claim on tap;
 * the card stays open showing Claiming… / Claimed until the tx lands.
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
  const { format, signedFormat } = useDisplayBalance();
  const [opened, setOpened] = useState(false);
  const flip = useSharedValue(0);
  const shake = useSharedValue(0);
  const pickLabel = sideDisplayLabel(reveal.side, reveal.kind, reveal.question);
  const isWin = reveal.won;
  const isVoid = reveal.outcome === "VOID";
  const isChain = reveal.claiming !== undefined || reveal.claimed !== undefined;

  const tint = isVoid ? colors.cyan : isWin ? colors.gold : colors.no;

  const open = () => {
    if (opened) return;
    setOpened(true);
    if (hapticsEnabled) {
      if (isVoid) haptics.tap();
      else if (isWin) haptics.win();
      else haptics.lose();
    }
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

  const statusLine = () => {
    if (reveal.claiming) {
      if (isVoid) return `Claiming ${format(reveal.stake)} refund…`;
      if (isWin) return `Claiming ${format(reveal.payout)}…`;
      return "Settling on-chain…";
    }
    if (reveal.claimed) {
      if (isVoid) return `${format(reveal.stake)} refunded`;
      if (isWin) return `${format(reveal.payout)} in your wallet`;
      return "Settled on-chain";
    }
    if (isVoid) {
      // A void = nobody took the other side, so the stake comes straight back. Frame it as the
      // money being safe (tap to claim on chain), never as a loss.
      return isChain
        ? `No taker on the other side · ${format(reveal.stake)} back — tap to claim`
        : `No taker on the other side · ${format(reveal.stake)} back`;
    }
    if (isWin) {
      return `${multiple(reveal.payoutMult)} on ${format(reveal.stake)}`;
    }
    return `${signedFormat(-reveal.stake)} · ${pickLabel} didn't land`;
  };

  return (
    <Surface
      radius={radius.xl}
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

      <Animated.View style={[styles.result, resultStyle]}>
        <Text
          style={[styles.verdict, { color: tint }]}
          allowFontScaling={false}
        >
          {reveal.claiming
            ? "CLAIMING"
            : reveal.claimed
              ? "CLAIMED"
              : isVoid
                ? "REFUNDED"
                : isWin
                  ? "YOU WON"
                  : "MISSED"}
        </Text>
        {isWin && !reveal.claiming ? (
          <View style={styles.payRow}>
            <AnimatedNumber
              value={reveal.payout}
              format={(n) => signedFormat(n)}
              style={[styles.payBig, { color: colors.gold }]}
            />
          </View>
        ) : null}
        <Text style={styles.payMeta}>{statusLine()}</Text>
        {reveal.claimed && reveal.claimUrl ? (
          <Text
            style={styles.claimLink}
            onPress={() => Linking.openURL(reveal.claimUrl!).catch(() => {})}
          >
            view claim tx ↗
          </Text>
        ) : null}
      </Animated.View>

      {opened ? null : <RevealCover style={coverStyle} onPress={open} isChain={isChain} />}
    </Surface>
  );
}

function RevealCover({
  style,
  onPress,
  isChain,
}: {
  style: ReturnType<typeof useAnimatedStyle>;
  onPress: () => void;
  isChain: boolean;
}) {
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
          <Text style={styles.coverSub}>
            {isChain ? "tap to reveal + claim payout" : "see how it played out"}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

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
  payMeta: { ...type.caption, fontSize: 12.5, color: colors.textMuted, textAlign: "center" },
  claimLink: { ...type.caption, fontSize: 11, color: colors.cyan, marginTop: 4 },
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
