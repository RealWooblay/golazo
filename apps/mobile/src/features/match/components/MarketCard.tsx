import React, { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { colors, radius, spacing, spring, type } from "@/theme";
import { AnimatedNumber, Surface, Text } from "@/ui";
import { money, multiple } from "@/lib/format";
import { RAKE, bettingClosesAt, bettingSafetyBufferMs } from "@/lib/config";
import type { MarketVM, PendingBet } from "@/state/types";
import {
  betLabels,
  isEventDecided,
  isWhistleBound,
  laneOf,
  sideDisplayLabel,
  withAlpha,
} from "../marketMeta";
import { useStore } from "@/state/store";
import { hapticIf } from "@/ui/haptics";

const FUSE_PIPS = 12;

/**
 * MarketCard — the live betting unit as a split PRICE BOARD (DraftKings × Polymarket).
 *
 * One pill whose DIVIDER sits at the crowd's lean, so the geometry itself is the implied
 * odds — the split bar and the two buttons collapse into a single object. Each half is a
 * tap target showing the live payout multiple as the hero plus a "$25 → $50" return.
 * Around it: a lane-colour spine, a telemetry header (pool · players · timer), a segmented
 * FUSE countdown, and a lean footer. Placed → one drifting receipt bar.
 *
 * Mode-aware: `formatStake` ($ vs points), `betDisabled` (chain twin preparing / window
 * closing), and the live `quote` flow from the parent.
 */
export function MarketCard({
  market,
  now,
  stake,
  pending,
  balance,
  onBet,
  formatStake = money,
  fixedOdds = false,
  betDisabled = false,
  breakActive = false,
}: {
  market: MarketVM;
  now: number;
  stake: number;
  pending: PendingBet | null;
  balance: number;
  onBet: (side: "YES" | "NO") => void;
  formatStake?: (n: number) => string;
  fixedOdds?: boolean;
  betDisabled?: boolean;
  breakActive?: boolean;
}) {
  const lane = laneOf(market.kind, market.slot, market.question);
  const labels = betLabels(market.kind, market.question);
  const eventDecided = isEventDecided(market.kind);

  const locked = market.phase !== "open";
  const betCutoff = bettingClosesAt(market.lockAt, market.windowMs);
  const closing = !locked && now >= betCutoff;
  const bettingOpen = !locked && !closing && !betDisabled;
  const left = Math.max(0, betCutoff - now);
  const seconds = Math.ceil(left / 1000);
  const betWindow = Math.max(1, market.windowMs - bettingSafetyBufferMs(market.windowMs));
  const barFrac = breakActive ? 1 : locked || closing ? 0 : Math.max(0, Math.min(1, left / betWindow));
  const urgent = !breakActive && !locked && (closing || seconds <= 3);

  const betPlaced = pending != null && pending.marketId === market.id;
  const canBet = bettingOpen && !betPlaced;
  const overBalance = stake > balance;

  // Gentle haptic countdown as the betting window runs out — a tactile "last call" tick at
  // 3, 2, 1 so you can feel the window closing without staring at the timer.
  const { session } = useStore();
  const lastTickRef = React.useRef(99);
  React.useEffect(() => {
    if (!locked && !betPlaced && !breakActive && seconds >= 1 && seconds <= 3) {
      if (seconds !== lastTickRef.current) {
        lastTickRef.current = seconds;
        hapticIf(session.hapticsOn, "selection");
      }
    } else if (seconds > 3 || locked) {
      lastTickRef.current = 99;
    }
  }, [seconds, locked, betPlaced, breakActive, session.hapticsOn]);

  // A small hint of the RESOLUTION window (the timer above is just the seconds left to BET).
  const resolveSec = Math.round((market.resolveAt - market.lockAt) / 1000);
  const windowHint =
    eventDecided || isWhistleBound(market.kind)
      ? null
      : resolveSec >= 100
        ? `resolves ~${Math.round(resolveSec / 60)} min`
        : `resolves ~${resolveSec}s`;

  const yesPool = market.pool * (market.yesShare / 100);
  const noPool = market.pool - yesPool;
  const quote = (side: "YES" | "NO") => {
    if (fixedOdds || stake <= 0) return side === "YES" ? market.oddsYes : market.oddsNo;
    const nextYes = yesPool + (side === "YES" ? stake : 0);
    const nextNo = noPool + (side === "NO" ? stake : 0);
    const nextGross = nextYes + nextNo;
    const sidePool = side === "YES" ? nextYes : nextNo;
    return sidePool > 0 ? (nextGross * (1 - RAKE)) / sidePool : 1;
  };

  // LIVE multiple for a placed bet — recomputed every render so the user WATCHES their
  // payout drift as the parimutuel pool fills.
  const liveMult =
    betPlaced && pending
      ? (() => {
          const sidePool = pending.side === "YES" ? yesPool : noPool;
          return sidePool > 0 ? (market.pool * (1 - RAKE)) / sidePool : pending.estimatedMult;
        })()
      : 0;

  // The divider seat = the crowd's lean. Floor each side so a lopsided pool never crushes a
  // half's hero number to nothing.
  const yesFlex = Math.max(30, Math.min(70, market.yesShare));
  const noFlex = 100 - yesFlex;
  const litCount = Math.ceil(barFrac * FUSE_PIPS);

  const tap = (side: "YES" | "NO") => {
    hapticIf(session.hapticsOn, side === "YES" ? "select" : "heavy");
    onBet(side);
  };

  return (
    <Surface radius={radius.lg} style={styles.card}>
      <View style={styles.body}>
        <View style={styles.header}>
          <View style={[styles.lanePill, { backgroundColor: withAlpha(lane.color, 0.14) }]}>
            <Text style={[styles.laneText, { color: lane.color }]}>{lane.label}</Text>
          </View>
          <View style={{ flex: 1 }} />
          <Text style={[styles.count, urgent && styles.countUrgent]}>
            {breakActive ? "on hold" : closing ? "betting closed" : `${seconds}s to bet`}
          </Text>
        </View>

        <Text style={styles.question} numberOfLines={2}>
          {market.question}
        </Text>

        {betPlaced ? (
          <ReceiptBar
            pending={pending!}
            mult={liveMult}
            format={formatStake}
            kind={market.kind}
            question={market.question}
          />
        ) : (
          <>
            <View style={styles.board}>
              <PriceHalf
                flex={yesFlex}
                color={colors.yes}
                verdict={labels.yes}
                odds={quote("YES")}
                stake={stake}
                format={formatStake}
                disabled={!canBet || overBalance}
                onPress={() => tap("YES")}
              />
              <View style={styles.seam} />
              <PriceHalf
                flex={noFlex}
                color={colors.no}
                verdict={labels.no}
                odds={quote("NO")}
                stake={stake}
                format={formatStake}
                disabled={!canBet || overBalance}
                onPress={() => tap("NO")}
              />
            </View>

            <View style={styles.fuse}>
              {Array.from({ length: FUSE_PIPS }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.pip,
                    {
                      backgroundColor:
                        i < litCount ? (urgent ? colors.no : lane.color) : colors.surface2,
                    },
                  ]}
                />
              ))}
            </View>

            <View style={styles.footer}>
              <Text style={styles.footHint}>
                {market.pool > 0
                  ? `${formatStake(market.pool)} pool · ${market.participants} playing`
                  : "be the first in"}
              </Text>
              {windowHint ? <Text style={styles.footLean}>{windowHint}</Text> : null}
            </View>
          </>
        )}
      </View>
    </Surface>
  );
}

function PriceHalf({
  flex,
  color,
  verdict,
  odds,
  stake,
  format,
  disabled,
  onPress,
}: {
  flex: number;
  color: string;
  verdict: string;
  odds: number;
  stake: number;
  format: (n: number) => string;
  disabled: boolean;
  onPress: () => void;
}) {
  const payout = stake > 0 ? Math.round(stake * odds) : 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.half,
        {
          flex,
          backgroundColor: withAlpha(color, pressed ? 0.32 : 0.15),
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <Text style={[styles.verdict, { color }]} numberOfLines={1}>
        {verdict}
      </Text>
      <Text style={[styles.odds, { color }]} allowFontScaling={false}>
        {multiple(odds).replace(/x$/, "")}
        <Text style={styles.oddsX}>x</Text>
      </Text>
      <Text style={[styles.ret, { color }]} numberOfLines={1}>
        {stake > 0 ? `${format(stake)} → ${format(payout)}` : " "}
      </Text>
    </Pressable>
  );
}

function ReceiptBar({
  pending,
  mult,
  format = money,
  kind,
  question,
}: {
  pending: PendingBet;
  mult: number;
  format?: (n: number) => string;
  kind?: string;
  question?: string;
}) {
  const isYes = pending.side === "YES";
  const tint = isYes ? colors.yes : colors.no;
  const fill = isYes ? colors.alpha.yes : colors.alpha.no;
  const pick = sideDisplayLabel(pending.side, kind, question);
  const m = mult > 0 ? mult : pending.estimatedMult;

  const scale = useSharedValue(0.96);
  const shimmer = useSharedValue(0);
  useEffect(() => {
    scale.value = withSequence(withSpring(1.02, spring.bouncy), withSpring(1, spring.smooth));
    shimmer.value = withRepeat(
      withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
    return () => cancelAnimation(shimmer);
  }, [scale, shimmer]);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const shimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(shimmer.value, [0, 1], [-240, 360]) }, { skewX: "-18deg" }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      style={[styles.receipt, { backgroundColor: fill, borderColor: tint }, animStyle]}
    >
      <Animated.View pointerEvents="none" style={[styles.shimmer, shimStyle]} />
      <View style={[styles.receiptDot, { backgroundColor: tint }]} />
      <Text style={[styles.receiptPick, { color: tint }]} numberOfLines={1}>
        {pick}
      </Text>
      <View style={{ flex: 1 }} />
      <AnimatedNumber value={m} format={multiple} style={[styles.receiptMult, { color: tint }]} />
      <Text style={styles.receiptStake}>· {format(pending.stake)} in</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  body: { padding: spacing.md, gap: spacing.sm },

  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  lanePill: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  laneText: { ...type.overline, fontSize: 10, letterSpacing: 0.8 },
  count: { ...type.mono, fontSize: 13, color: colors.textMuted },
  countUrgent: { color: colors.no, fontWeight: "700" },

  question: { ...type.title, fontSize: 18, lineHeight: 23, color: colors.textPrimary },

  board: {
    flexDirection: "row",
    height: 76,
    borderRadius: radius.md,
    overflow: "hidden",
    marginTop: 2,
  },
  seam: { width: 2, backgroundColor: colors.bg },
  half: { justifyContent: "center", alignItems: "center", paddingHorizontal: 6, gap: 1 },
  verdict: { ...type.overline, fontSize: 11, letterSpacing: 0.6 },
  odds: { ...type.display, fontSize: 30, lineHeight: 34 },
  oddsX: { fontSize: 17, opacity: 0.55 },
  ret: { ...type.mono, fontSize: 11, opacity: 0.8 },

  fuse: { flexDirection: "row", gap: 3, marginTop: spacing.xs },
  pip: { flex: 1, height: 4, borderRadius: 2 },

  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footHint: { ...type.mono, fontSize: 11, color: colors.textFaint },
  footLean: { ...type.mono, fontSize: 11, color: colors.textMuted },

  receipt: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 54,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: 2,
    overflow: "hidden",
  },
  shimmer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 70,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  receiptDot: { width: 8, height: 8, borderRadius: 4 },
  receiptPick: { ...type.subtitle, fontSize: 15 },
  receiptMult: { ...type.display, fontSize: 17 },
  receiptStake: { ...type.mono, fontSize: 12, color: colors.textSecondary },
});
