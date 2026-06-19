import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { colors, spacing, type } from "@/theme";
import { AnimatedNumber, ProgressBar, Text } from "@/ui";
import { money, multiple } from "@/lib/format";

const CARD_W = 320; // app column inner width (used for the shimmer sweep)

/**
 * PoolMeter — the live pool readout beside the countdown ring:
 *   • the gross pool total, counting UP as crowd + your money lands,
 *   • the YES / NO indicative multiples for the selected stake (animated tickers),
 *   • the split bar (lime YES from the left, red NO from the right) with a
 *     shimmer riding it while the window is open,
 *   • a "crowd" pulse line that ticks whenever the pool jumps, so a quiet market
 *     still feels like money is moving (the brief's "bot activity / live feel").
 */
export function PoolMeter({
  pool,
  oddsYes,
  oddsNo,
  yesShare,
  live,
  format = money,
}: {
  pool: number;
  oddsYes: number;
  oddsNo: number;
  yesShare: number; // 0..100
  live: boolean; // window open → shimmer + crowd ticks
  format?: (n: number) => string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.label}>POOL</Text>
        <AnimatedNumber value={pool} format={format} style={styles.pool} />
      </View>

      <View style={styles.oddsRow}>
        <View style={styles.oddsCell}>
          <Text style={[styles.side, { color: colors.yes }]}>YES</Text>
          <AnimatedNumber
            value={oddsYes}
            format={multiple}
            style={[styles.odds, { color: colors.yes }]}
          />
        </View>
        <CrowdPulse pool={pool} live={live} />
        <View style={[styles.oddsCell, styles.oddsRight]}>
          <AnimatedNumber
            value={oddsNo}
            format={multiple}
            style={[styles.odds, { color: colors.no }]}
          />
          <Text style={[styles.side, { color: colors.no }]}>NO</Text>
        </View>
      </View>

      <ProgressBar
        value={yesShare / 100}
        tone="split"
        shimmer={live}
        height={9}
        width={CARD_W}
        style={styles.bar}
      />
    </View>
  );
}

/**
 * CrowdPulse — a tiny center indicator: a dot + "live bets" that flashes each time
 * the pool grows (a bot or you just bet). Quietly fades when nothing's moving.
 */
function CrowdPulse({ pool, live }: { pool: number; live: boolean }) {
  const prev = useRef(pool);
  const [count, setCount] = useState(0);
  const flash = useSharedValue(0);

  useEffect(() => {
    if (pool > prev.current && live) {
      setCount((c) => c + 1);
      flash.value = withSequence(
        withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) }),
        withTiming(0.25, { duration: 520 }),
      );
    }
    prev.current = pool;
  }, [pool, live, flash]);

  useEffect(() => {
    if (!live) {
      cancelAnimation(flash);
      flash.value = withTiming(0, { duration: 240 });
    }
    return () => cancelAnimation(flash);
  }, [live, flash]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + flash.value * 0.7,
    transform: [{ scale: 0.9 + flash.value * 0.5 }],
  }));
  if (!live) return <View style={styles.crowd} />;

  return (
    <View style={styles.crowd}>
      <Animated.View style={[styles.crowdDot, dotStyle]} />
      <Text style={styles.crowdText}>
        {count > 0 ? `${count} live bets` : "taking bets"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 7 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    ...type.overline,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.4,
  },
  pool: { ...type.mono, fontSize: 16, color: colors.textPrimary },
  oddsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  oddsCell: { flexDirection: "row", alignItems: "baseline", gap: 5 },
  oddsRight: { justifyContent: "flex-end" },
  side: { ...type.overline, fontSize: 10, letterSpacing: 0.8 },
  odds: { ...type.mono, fontSize: 15 },
  crowd: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 14,
  },
  crowdDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.cyan,
  },
  crowdText: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 0.6,
  },
  bar: { marginTop: 1 },
});
