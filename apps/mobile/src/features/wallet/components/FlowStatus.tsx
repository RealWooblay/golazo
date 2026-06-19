import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { AnimatedNumber, Button, Confetti, Text } from "@/ui";
import { colors, spacing, spring, type } from "@/theme";
import { money } from "@/lib/format";
import type { FlowKind, FlowStatus as FlowStatusKind } from "../useWallet";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * FlowStatus — the full-bleed pending → success | error state both money modals
 * render once a flow is in flight. It owns the *feel* of the moment:
 *
 *   • pending — a sweeping lime ring spins while we "process" (the sandbox beat).
 *   • success — the ring snaps to a checkmark, the amount counts up, confetti
 *     bursts (deposit) / a gold tick (withdraw), success copy + a Done button.
 *   • error   — a red ring + X, the message, and a Try again / Done button.
 *
 * Presentational: the parent (deposit/withdraw modal) passes the flow snapshot
 * from {@link useWallet} and the done/retry handlers. Confetti only on a deposit
 * success (money IN = celebrate); withdrawals get a calmer gold confirmation.
 */
export interface FlowStatusProps {
  kind: FlowKind;
  status: FlowStatusKind;
  amount: number;
  message?: string;
  onDone: () => void;
  onRetry?: () => void;
}

const RING = 100; // viewbox radius helper
const R = 42;
const C = 2 * Math.PI * R;

export function FlowStatus({
  kind,
  status,
  amount,
  message,
  onDone,
  onRetry,
}: FlowStatusProps) {
  const isDeposit = kind === "deposit";
  const success = status === "success";
  const error = status === "error";

  // Spin while pending.
  const spin = useSharedValue(0);
  // Sweep / settle progress 0..1 for the ring on success.
  const settle = useSharedValue(0);
  // Confetti trigger (deposit success only).
  const burst = useSharedValue(0);
  const [burstN, setBurstN] = React.useState(0);

  useEffect(() => {
    if (status === "pending") {
      spin.value = withRepeat(
        withTiming(1, { duration: 900, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(spin);
    }
    return () => cancelAnimation(spin);
  }, [status, spin]);

  useEffect(() => {
    if (success) {
      settle.value = 0;
      settle.value = withSpring(1, spring.bouncy);
      if (isDeposit) {
        burst.value = 1;
        setBurstN((n) => n + 1);
      }
    } else if (error) {
      settle.value = withSpring(1, spring.snappy);
    }
  }, [success, error, isDeposit, settle, burst]);

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  // Pending arc = a 25%-length stroke; success/error arc = full ring drawn in.
  const arcProps = useAnimatedProps(() => {
    if (status === "pending") {
      return { strokeDashoffset: C * 0.75 };
    }
    return { strokeDashoffset: C * (1 - settle.value) };
  });

  // Checkmark / X path reveal.
  const markStyle = useAnimatedStyle(() => ({ opacity: settle.value }));

  const accent = error ? colors.no : isDeposit ? colors.yes : colors.gold;

  const heading = error
    ? "Hmm, that didn't go through"
    : success
      ? isDeposit
        ? "You're loaded up"
        : "Cash is on its way"
      : isDeposit
        ? "Adding cash…"
        : "Cashing out…";

  const sub =
    message ??
    (error
      ? "Give it another shot."
      : success
        ? isDeposit
          ? "Your balance is ready to play."
          : "It’ll land in moments."
        : "Securing your transaction…");

  return (
    <View style={styles.root}>
      {isDeposit && success ? <Confetti trigger={burstN} count={32} /> : null}

      <View style={styles.ringWrap}>
        <Animated.View style={status === "pending" ? spinStyle : undefined}>
          <Svg width={120} height={120} viewBox={`0 0 ${RING} ${RING}`}>
            {/* track */}
            <Circle
              cx={RING / 2}
              cy={RING / 2}
              r={R}
              stroke={colors.hairline}
              strokeWidth={6}
              fill="none"
            />
            {/* progress / settle arc */}
            <AnimatedCircle
              cx={RING / 2}
              cy={RING / 2}
              r={R}
              stroke={accent}
              strokeWidth={6}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={C}
              animatedProps={arcProps}
              transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
            />
          </Svg>
        </Animated.View>

        {/* check / X overlay */}
        {(success || error) && (
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.markWrap, markStyle]}
          >
            <Svg width={120} height={120} viewBox={`0 0 ${RING} ${RING}`}>
              {error ? (
                <Path
                  d="M37 37 L63 63 M63 37 L37 63"
                  stroke={accent}
                  strokeWidth={6}
                  strokeLinecap="round"
                />
              ) : (
                <Path
                  d="M34 51 L46 63 L68 39"
                  stroke={accent}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              )}
            </Svg>
          </Animated.View>
        )}
      </View>

      {success ? (
        <AnimatedNumber
          value={amount}
          format={(n) => (isDeposit ? `+${money(n)}` : `−${money(n)}`)}
          style={[type.display, styles.amount, { color: accent }]}
        />
      ) : null}

      <Text style={[type.title, styles.heading]}>{heading}</Text>
      <Text style={[type.body, styles.sub]}>{sub}</Text>

      <View style={styles.actions}>
        {error && onRetry ? (
          <Button
            label="Try again"
            onPress={onRetry}
            variant="primary"
            size="lg"
            fullWidth
          />
        ) : null}
        {status !== "pending" ? (
          <Button
            label={success ? (isDeposit ? "Let's play" : "Done") : "Close"}
            onPress={onDone}
            variant={error ? "ghost" : "primary"}
            size="lg"
            fullWidth
            glow={!error}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxl,
    gap: spacing.md,
  },
  ringWrap: {
    width: 120,
    height: 120,
    alignItems: "center",
    justifyContent: "center",
  },
  markWrap: { alignItems: "center", justifyContent: "center" },
  amount: { marginTop: spacing.sm },
  heading: { color: colors.textPrimary, textAlign: "center" },
  sub: { color: colors.textMuted, textAlign: "center", maxWidth: 300 },
  actions: { alignSelf: "stretch", marginTop: spacing.lg, gap: spacing.sm },
});
