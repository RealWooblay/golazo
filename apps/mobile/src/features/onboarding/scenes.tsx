import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";
import { colors, motion, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { GradientFill, Vignette } from "../_shared/primitives";

/**
 * ONBOARDING SCENES — the animated "hero" art for each slide. No image assets:
 * each is a small reanimated + SVG composition that sells the hook visually.
 *
 *   1. SceneMarketPop  — a market card springs in, a countdown ring sweeps, a
 *                        YES tap lands. ("Bet the play.")
 *   2. SceneInstantPay — a balance number counts up with a coin/confetti pop.
 *                        ("Get paid in seconds.")
 *   3. SceneLiveSlate  — pulsing live dots over a tiny fixture stack.
 *                        ("Every match, every moment.")
 */

const SIZE = 240;

function SceneFrame({
  children,
  tint = colors.yes,
}: {
  children: React.ReactNode;
  tint?: string;
}) {
  return (
    <View style={styles.frame}>
      <Vignette color={tint} opacity={0.18} cx="50%" cy="42%" />
      <View style={styles.stage}>{children}</View>
    </View>
  );
}

/** Slide 1 — the market card + countdown ring + a YES tap. */
export function SceneMarketPop() {
  const enter = useSharedValue(0);
  const ring = useSharedValue(0);
  const tap = useSharedValue(0);

  useEffect(() => {
    enter.value = withSpring(1, motion.spring.entrance);
    ring.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.linear }),
      -1,
      false,
    );
    tap.value = withRepeat(
      withSequence(
        withDelay(
          900,
          withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) }),
        ),
        withTiming(0, { duration: 240, easing: Easing.in(Easing.cubic) }),
        withDelay(1400, withTiming(0, { duration: 1 })),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(enter);
      cancelAnimation(ring);
      cancelAnimation(tap);
    };
  }, [enter, ring, tap]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      { scale: interpolate(enter.value, [0, 1], [0.86, 1]) },
      { translateY: interpolate(enter.value, [0, 1], [18, 0]) },
    ],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${ring.value * 360}deg` }],
  }));
  const yesStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(tap.value, [0, 1], [1, 0.92]) }],
    opacity: interpolate(tap.value, [0, 1], [1, 0.85]),
  }));
  const fingerStyle = useAnimatedStyle(() => ({
    opacity: tap.value,
    transform: [
      { translateX: interpolate(tap.value, [0, 1], [10, 0]) },
      { translateY: interpolate(tap.value, [0, 1], [10, 0]) },
      { scale: interpolate(tap.value, [0, 1], [0.9, 1]) },
    ],
  }));

  return (
    <SceneFrame tint={colors.yes}>
      {/* countdown ring */}
      <View style={styles.ringWrap}>
        <Svg width={170} height={170} viewBox="0 0 170 170">
          <Circle
            cx="85"
            cy="85"
            r="74"
            stroke={colors.hairline}
            strokeWidth={6}
            fill="none"
          />
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, ringStyle]}>
          <Svg width={170} height={170} viewBox="0 0 170 170">
            <Defs>
              <LinearGradient id="obRing" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor={colors.raw.lime} />
                <Stop offset="100%" stopColor={colors.raw.cyan} />
              </LinearGradient>
            </Defs>
            <Circle
              cx="85"
              cy="85"
              r="74"
              stroke="url(#obRing)"
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray="150 320"
              fill="none"
            />
          </Svg>
        </Animated.View>
      </View>

      {/* the market card */}
      <Animated.View style={[styles.card, cardStyle]}>
        <View style={styles.cardChip}>
          <View style={styles.liveDot} />
          <Text style={styles.cardChipText}>LIVE · 7s</Text>
        </View>
        <Text style={styles.cardQ} numberOfLines={2}>
          Argentina on the attack — GOAL?
        </Text>
        <View style={styles.cardBtns}>
          <Animated.View style={[styles.yesBtn, yesStyle]}>
            <View style={styles.btnFill}>
              <GradientFill
                colors={["#1fff9f", "#00d27e"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
            </View>
            <Text style={styles.yesText}>YES 3.4x</Text>
          </Animated.View>
          <View style={styles.noBtn}>
            <Text style={styles.noText}>NO 1.5x</Text>
          </View>
        </View>
        {/* the tapping finger */}
        <Animated.View
          style={[styles.finger, fingerStyle]}
          pointerEvents="none"
        >
          <Svg width={36} height={36} viewBox="0 0 24 24">
            <Path
              d="M9 11V5.5a1.5 1.5 0 013 0V11l1-3a1.4 1.4 0 012.7.6l-.4 2.2 1.3.3a1.5 1.5 0 011.1 1.8l-.9 3.6A3 3 0 0114 19h-2.5a3 3 0 01-2.4-1.2L6 13.5a1.5 1.5 0 012.4-1.8L9 12.5"
              fill={colors.raw.white}
              opacity={0.92}
            />
          </Svg>
        </Animated.View>
      </Animated.View>
    </SceneFrame>
  );
}

/** Slide 2 — the payout: a balance counts up with a coin burst. */
export function SceneInstantPay() {
  const v = useSharedValue(0);
  const [n, setN] = React.useState(0);

  useEffect(() => {
    const loop = () => {
      v.value = withSequence(
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) }),
        withDelay(1200, withTiming(0, { duration: 1 })),
      );
    };
    loop();
    const tick = setInterval(() => {
      // count-up driven on JS for the displayed number (web-safe)
      const start = Date.now();
      const from = 1000;
      const to = 1242;
      const step = () => {
        const p = Math.min(1, (Date.now() - start) / 1000);
        setN(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
        else setTimeout(() => setN(1000), 1300);
      };
      requestAnimationFrame(step);
    }, 2500);
    // kick once immediately
    const startNow = Date.now();
    const stepNow = () => {
      const p = Math.min(1, (Date.now() - startNow) / 1000);
      setN(Math.round(1000 + 242 * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(stepNow);
    };
    requestAnimationFrame(stepNow);
    return () => {
      cancelAnimation(v);
      clearInterval(tick);
    };
  }, [v]);

  return (
    <SceneFrame tint={colors.gold}>
      <View style={styles.payWrap}>
        <Text style={styles.payLabel}>YOU WON</Text>
        <Text style={styles.payValue} allowFontScaling={false}>
          ${n.toLocaleString("en-US")}
        </Text>
        <View style={styles.payDelta}>
          <Text style={styles.payDeltaText}>+$242 · 3.4x</Text>
        </View>
      </View>
      {/* coin burst */}
      {[...Array(7)].map((_, i) => (
        <Coin key={i} index={i} progress={v} />
      ))}
    </SceneFrame>
  );
}

function Coin({
  index,
  progress,
}: {
  index: number;
  progress: Animated.SharedValue<number>;
}) {
  const angle = (index / 7) * Math.PI - Math.PI / 2; // fan upward
  const dist = 90 + (index % 3) * 18;
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [0, Math.cos(angle) * dist],
        ),
      },
      {
        translateY: interpolate(
          progress.value,
          [0, 1],
          [0, Math.sin(angle) * dist],
        ),
      },
      { scale: interpolate(progress.value, [0, 0.2, 1], [0.4, 1, 0.7]) },
      { rotate: `${progress.value * (index % 2 ? 320 : -320)}deg` },
    ],
  }));
  return (
    <Animated.View style={[styles.coin, style]} pointerEvents="none">
      <Svg width={18} height={18} viewBox="0 0 18 18">
        <Circle cx="9" cy="9" r="8" fill={colors.raw.gold} />
        <Circle
          cx="9"
          cy="9"
          r="5.5"
          fill="none"
          stroke={colors.raw.goldDeep}
          strokeWidth={1.4}
        />
      </Svg>
    </Animated.View>
  );
}

/** Slide 3 — a stack of live fixtures with pulsing dots. */
export function SceneLiveSlate() {
  const enter = useSharedValue(0);
  useEffect(() => {
    enter.value = withSpring(1, motion.spring.entrance);
    return () => cancelAnimation(enter);
  }, [enter]);

  const rows = [
    {
      a: "#7cc3ff",
      b: "#3d7cff",
      c: "#ff5d6c",
      d: "#c8102e",
      tint: colors.yes,
    },
    {
      a: "#f4f6fb",
      b: "#c9ccd6",
      c: "#b3308f",
      d: "#5b1fb0",
      tint: colors.cyan,
    },
    {
      a: "#ff5d6c",
      b: "#d40026",
      c: "#ffd84a",
      d: "#f5b400",
      tint: colors.gold,
    },
  ];

  return (
    <SceneFrame tint={colors.cyan}>
      <View style={styles.slate}>
        {rows.map((r, i) => (
          <SlateRow key={i} index={i} enter={enter} {...r} />
        ))}
      </View>
    </SceneFrame>
  );
}

function SlateRow({
  index,
  enter,
  a,
  b,
  c,
  d,
  tint,
}: {
  index: number;
  enter: Animated.SharedValue<number>;
  a: string;
  b: string;
  c: string;
  d: string;
  tint: string;
}) {
  const style = useAnimatedStyle(() => {
    const p = interpolate(enter.value, [0, 1], [0, 1]);
    return {
      opacity: p,
      transform: [
        { translateX: interpolate(p, [0, 1], [(index % 2 ? 1 : -1) * 30, 0]) },
      ],
    };
  });
  return (
    <Animated.View style={[styles.slateRow, style]}>
      <CrestDot from={a} to={b} />
      <CrestDot from={c} to={d} />
      <View style={styles.slateBars}>
        <View style={[styles.slateBar, { width: 56 }]} />
        <View style={[styles.slateBar, { width: 38, opacity: 0.6 }]} />
      </View>
      <View style={[styles.slatePulse, { borderColor: tint }]}>
        <PulseCore color={tint} />
      </View>
    </Animated.View>
  );
}

function CrestDot({ from, to }: { from: string; to: string }) {
  return (
    <View style={styles.crestDot}>
      <Svg width={22} height={22} viewBox="0 0 22 22">
        <Defs>
          <LinearGradient id={`cd${from}${to}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={from} />
            <Stop offset="100%" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Rect width="22" height="22" rx="7" fill={`url(#cd${from}${to})`} />
      </Svg>
    </View>
  );
}

function PulseCore({ color }: { color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: motion.duration.dot }),
      -1,
      true,
    );
    return () => cancelAnimation(t);
  }, [t]);
  const s = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [1, 0.4]),
  }));
  return (
    <Animated.View style={[styles.pulseCore, { backgroundColor: color }, s]} />
  );
}

const styles = StyleSheet.create({
  frame: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  stage: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
  },

  // market card
  ringWrap: {
    position: "absolute",
    width: 170,
    height: 170,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    width: 210,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: "rgba(0,229,138,0.3)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    shadowColor: colors.yes,
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  cardChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    backgroundColor: colors.alpha.yes,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.yes,
  },
  cardChipText: { ...type.overline, color: colors.yes, fontSize: 8 },
  cardQ: { ...type.subtitle, color: colors.textPrimary, fontSize: 15 },
  cardBtns: { flexDirection: "row", gap: spacing.sm, marginTop: 2 },
  yesBtn: {
    flex: 1,
    height: 38,
    borderRadius: radius.sm,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  btnFill: { ...StyleSheet.absoluteFillObject },
  yesText: { ...type.subtitle, color: colors.onYes, fontSize: 13 },
  noBtn: {
    flex: 1,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.alpha.no,
    borderWidth: 1,
    borderColor: "rgba(255,77,109,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  noText: { ...type.subtitle, color: colors.no, fontSize: 13 },
  finger: { position: "absolute", right: 30, bottom: -6 },

  // pay scene
  payWrap: { alignItems: "center", gap: spacing.xs },
  payLabel: {
    ...type.overline,
    color: colors.gold,
    fontSize: 11,
    letterSpacing: 2,
  },
  payValue: { ...type.hero, color: colors.textPrimary, fontSize: 54 },
  payDelta: {
    backgroundColor: colors.alpha.gold,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(255,199,58,0.4)",
  },
  payDeltaText: { ...type.mono, color: colors.gold, fontSize: 14 },
  coin: { position: "absolute" },

  // slate scene
  slate: { gap: spacing.md, width: 210 },
  slateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  crestDot: {},
  slateBars: { flex: 1, gap: 5, marginLeft: 4 },
  slateBar: { height: 6, borderRadius: 3, backgroundColor: colors.surface3 },
  slatePulse: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  pulseCore: { width: 7, height: 7, borderRadius: 4 },
});
