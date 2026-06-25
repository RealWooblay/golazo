import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from "react-native-reanimated";
import { colors, radius, spacing, spring, type } from "@/theme";
import { Surface, Text } from "@/ui";
import { money, multiple } from "@/lib/format";
import { RAKE, bettingClosesAt, bettingSafetyBufferMs } from "@/lib/config";
import type { MarketVM, PendingBet } from "@/state/types";
import { BetButton } from "./BetButton";
import { betLabels, isEventDecided, isWhistleBound, laneOf, sideDisplayLabel, withAlpha } from "../marketMeta";
import { useStore } from "@/state/store";
import { hapticIf } from "@/ui/haptics";

/**
 * MarketCard — the compact, one-tap betting card. A short window made catchable:
 * a draining countdown bar across the top (red in the last seconds), a lane tag,
 * the bold question, and two big honest-verdict buttons (Shot / No shot, Goal / No
 * goal, Scores / Doesn't…). No per-card stake row — the stake is global. Locked
 * markets are rendered as thin strips by the parent, so this is the OPEN state.
 *
 * Mode-aware: `formatStake` ($ vs points), `betDisabled` (on-chain twin preparing
 * / window closing), and the live `quote` all flow from the parent.
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
  const barColor = urgent ? colors.no : lane.color;

  const betPlaced = pending != null && pending.marketId === market.id;
  const canBet = bettingOpen && !betPlaced;
  const overBalance = stake > balance;

  // Gentle haptic countdown as the betting window runs out — a tactile "last call" tick at
  // 3, 2, 1 so you can feel the window closing without staring at the timer. Respects the
  // user's haptics pref and never fires once you've already placed your bet.
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

  // "how long is 'soon'?" — a small hint of the RESOLUTION window (the bar/count above is just
  // the few seconds left to BET). Only on timer-settled window markets; versus/whistle markets
  // say their own timeframe in the wording.
  const resolveSec = Math.round((market.resolveAt - market.lockAt) / 1000);
  const windowHint =
    eventDecided || isWhistleBound(market.kind)
      ? null
      : resolveSec >= 100
        ? `resolves over ~${Math.round(resolveSec / 60)} min`
        : `resolves over ~${resolveSec}s`;

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

  // LIVE multiple for a placed bet — recomputed from the CURRENT pool every render, so
  // the user WATCHES their payout settle as others pile in (parimutuel drifts), instead
  // of being shown a frozen bet-time number that no longer matches what they'll receive.
  const liveMult =
    betPlaced && pending
      ? (() => {
          const sidePool = pending.side === "YES" ? yesPool : noPool;
          return sidePool > 0 ? (market.pool * (1 - RAKE)) / sidePool : pending.estimatedMult;
        })()
      : 0;

  return (
    <Surface
      radius={radius.lg}
      style={[styles.card, { borderColor: withAlpha(lane.color, 0.4) }]}
    >
      <View style={styles.barTrack}>
        <View
          style={[styles.barFill, { width: `${barFrac * 100}%`, backgroundColor: barColor }]}
        />
      </View>

      <View style={styles.body}>
        <View style={styles.head}>
          <Text style={[styles.tag, { color: lane.color }]}>{lane.label}</Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.count, urgent && { color: colors.no }]}>
            {breakActive ? "⏸ break" : closing ? "closing" : eventDecided ? `${seconds}s to bet` : `${seconds}s`}
          </Text>
        </View>

        <Text style={styles.question} numberOfLines={2}>
          {market.question}
        </Text>
        {windowHint ? <Text style={styles.window}>{windowHint}</Text> : null}

        {betPlaced ? (
          <BetConfirmation
            pending={pending!}
            mult={liveMult}
            format={formatStake}
            kind={market.kind}
            question={market.question}
          />
        ) : (
          <View style={styles.btns}>
            <BetButton
              side="YES"
              odds={quote("YES")}
              label={labels.yes}
              onPress={() => onBet("YES")}
              disabled={!canBet || overBalance}
              picked={null}
            />
            <BetButton
              side="NO"
              odds={quote("NO")}
              label={labels.no}
              onPress={() => onBet("NO")}
              disabled={!canBet || overBalance}
              picked={null}
            />
          </View>
        )}
      </View>
    </Surface>
  );
}

function BetConfirmation({
  pending,
  mult,
  format = money,
  kind,
  question,
}: {
  pending: PendingBet;
  /** LIVE multiple from the current pool (drifts until lock); falls back to bet-time est. */
  mult: number;
  format?: (n: number) => string;
  kind?: string;
  question?: string;
}) {
  const isYes = pending.side === "YES";
  const tint = isYes ? colors.yes : colors.no;
  const fill = isYes ? colors.alpha.yes : colors.alpha.no;
  const pickLabel = sideDisplayLabel(pending.side, kind, question);
  const scale = useSharedValue(0.9);
  useEffect(() => {
    scale.value = withSequence(withSpring(1.04, spring.bouncy), withSpring(1, spring.smooth));
  }, [scale]);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      style={[styles.locked, { backgroundColor: fill, borderColor: tint }, animStyle]}
    >
      <View style={[styles.lockedDot, { backgroundColor: tint }]} />
      <Text style={[styles.lockedText, { color: tint }]}>
        {pickLabel} · {multiple(mult > 0 ? mult : pending.estimatedMult)}
      </Text>
      <Text style={styles.lockedStake}>{format(pending.stake)} in</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 0, overflow: "hidden", borderWidth: 1 },
  barTrack: { height: 3, backgroundColor: colors.surface2 },
  barFill: { height: 3 },
  body: { padding: spacing.md, gap: spacing.sm },
  head: { flexDirection: "row", alignItems: "center" },
  tag: {
    ...type.overline,
    fontSize: 10.5,
    letterSpacing: 0.6,
  },
  count: { ...type.mono, fontSize: 13, color: colors.textMuted },
  window: { ...type.mono, fontSize: 11, color: colors.textFaint, marginTop: -2 },
  question: {
    ...type.title,
    fontSize: 18,
    lineHeight: 23,
    color: colors.textPrimary,
  },
  btns: { flexDirection: "row", gap: spacing.sm, marginTop: 2 },
  locked: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: 2,
  },
  lockedDot: { width: 8, height: 8, borderRadius: 4 },
  lockedText: { ...type.subtitle, fontSize: 15, flex: 1 },
  lockedStake: { ...type.mono, fontSize: 13, color: colors.textSecondary },
});
