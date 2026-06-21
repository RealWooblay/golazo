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
import { Chip, Surface, Text } from "@/ui";
import { money, multiple } from "@/lib/format";
import { RAKE } from "@/lib/config";
import { bettingClosesAt, bettingSafetyBufferMs } from "@/lib/config";
import type { MarketVM, PendingBet } from "@/state/types";
import { CountdownRing } from "./CountdownRing";
import { PoolMeter } from "./PoolMeter";
import { StakeRow } from "./StakeRow";
import { BetButton } from "./BetButton";

/**
 * MarketCard — the heart of the loop. Renders one in-play market through its
 * lifecycle:
 *
 *   OPEN   → phase chip (LIVE, pulsing), the bold question, the countdown ring,
 *            the live PoolMeter (pool/odds/split), stake chips, and the two big
 *            YES/NO buttons. Tap a side → a confirmation strip slides in with
 *            the non-guaranteed estimate and the buttons settle.
 *   LOCKED → ring shows ⏳, the card reads "Bets are in. Here it comes…", any
 *            placed bet still shows its confirmation. Tension, no actions.
 *
 * Pure presentation: the parent owns the engine + tick clock and passes the flat
 * MarketVM, the live `now`, the chosen stake, and the placeBet callback.
 */
export function MarketCard({
  market,
  now,
  stake,
  onStakeChange,
  pending,
  balance,
  onBet,
  formatStake = money,
  fixedOdds = false,
  hapticsEnabled = true,
  betDisabled = false,
}: {
  market: MarketVM;
  now: number;
  stake: number;
  onStakeChange: (n: number) => void;
  pending: PendingBet | null;
  /** Balance in stake "units" ($ chips) — used only for the over-balance gate. */
  balance: number;
  onBet: (side: "YES" | "NO") => void;
  /** Stake formatter — SOL in chain mode, $ in sandbox. Default money. */
  formatStake?: (n: number) => string;
  /**
   * Fixed-odds mode: show `market.oddsYes/oddsNo` as-is rather than recomputing
   * pool-implied parimutuel odds. Used by FRIENDS MODE, where you bet POINTS vs
   * the book at locked odds (even money / model odds) — not into a shared pool.
   */
  fixedOdds?: boolean;
  hapticsEnabled?: boolean;
  /** External gate (e.g. on-chain twin still initializing). */
  betDisabled?: boolean;
}) {
  const locked = market.phase !== "open";
  const betCutoff = bettingClosesAt(market.lockAt, market.windowMs);
  const closing = !locked && now >= betCutoff;
  const bettingOpen = !locked && !closing && !betDisabled;
  const resolveWindowMs = market.resolveWindowMs > 0 ? market.resolveWindowMs : 60_000;
  const resolveAt =
    market.resolveAt > 0 ? market.resolveAt : market.lockAt + resolveWindowMs;
  const left = bettingOpen
    ? Math.max(0, betCutoff - now)
    : locked
      ? Math.max(0, resolveAt - now)
      : Math.max(0, market.lockAt - now);
  const fraction =
    market.windowMs > 0
      ? bettingOpen
        ? left / Math.max(1, market.windowMs - bettingSafetyBufferMs(market.windowMs))
        : closing
          ? (market.lockAt - now) / bettingSafetyBufferMs(market.windowMs)
          : locked
            ? left / Math.max(1, resolveWindowMs)
            : 0
      : 0;
  const seconds = left / 1000;
  const resolveMins = Math.floor(seconds / 60);
  const resolveSecs = Math.floor(seconds % 60);
  const resolveLabel =
    resolveMins > 0
      ? `${resolveMins}:${String(resolveSecs).padStart(2, "0")}`
      : `${Math.ceil(seconds)}s`;

  const betPlaced = pending != null && pending.marketId === market.id;
  const canBet = bettingOpen && !betPlaced;
  const yesPool = market.pool * (market.yesShare / 100);
  const noPool = market.pool - yesPool;
  const quote = (side: "YES" | "NO") => {
    // Fixed-odds (friends mode): the locked multiple, no pool math / no rake.
    if (fixedOdds) return side === "YES" ? market.oddsYes : market.oddsNo;
    if (stake <= 0) return side === "YES" ? market.oddsYes : market.oddsNo;
    const nextYes = yesPool + (side === "YES" ? stake : 0);
    const nextNo = noPool + (side === "NO" ? stake : 0);
    const nextGross = nextYes + nextNo;
    const sidePool = side === "YES" ? nextYes : nextNo;
    return sidePool > 0 ? (nextGross * (1 - RAKE)) / sidePool : 1;
  };

  return (
    <Surface
      radius={radius.xl}
      glow={locked ? "gold" : "yes"}
      borderColor={locked ? colors.glow.goldSoft : colors.glow.yesSoft}
      style={styles.card}
    >
      {/* header: phase chip + question */}
      <View style={styles.head}>
        <Chip
          label={
            locked
              ? `LOCKED · ${resolveLabel} left`
              : closing
                ? "CLOSING · no more bets"
                : "LIVE · bet now"
          }
          tone={locked ? "win" : closing ? "win" : "live"}
          dot
        />
        <Text style={styles.question}>{market.question}</Text>
        {market.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {market.subtitle}
          </Text>
        ) : null}
      </View>

      {/* ring + pool */}
      <View style={styles.ringRow}>
        <CountdownRing
          fraction={fraction}
          seconds={seconds}
          locked={locked || closing}
          urgent={bettingOpen}
          hapticsEnabled={hapticsEnabled}
          lockedPhase={locked}
        />
        <PoolMeter
          pool={market.pool}
          oddsYes={quote("YES")}
          oddsNo={quote("NO")}
          yesShare={market.yesShare}
          live={!locked}
          format={formatStake}
        />
      </View>

      {/* bet confirmation OR the stake selector */}
      {betPlaced ? (
        <BetConfirmation pending={pending!} format={formatStake} />
      ) : (
        <StakeRow
          stake={stake}
          onChange={onStakeChange}
          balance={balance}
          format={formatStake}
          disabled={!canBet}
          hapticsEnabled={hapticsEnabled}
        />
      )}

      {/* the two big buttons */}
      <View style={styles.btns}>
        <BetButton
          side="YES"
          odds={quote("YES")}
          sublabel="est. goal"
          onPress={() => onBet("YES")}
          disabled={!canBet || stake > balance}
          picked={betPlaced ? pending!.side : null}
        />
        <BetButton
          side="NO"
          odds={quote("NO")}
          sublabel="est. no goal"
          onPress={() => onBet("NO")}
          disabled={!canBet || stake > balance}
          picked={betPlaced ? pending!.side : null}
        />
      </View>

      {closing && !betPlaced ? (
        <Text style={styles.sat} center>
          Betting closed — waiting for lock. Outcome may be imminent.
        </Text>
      ) : locked && !betPlaced ? (
        <Text style={styles.sat} center>
          Watching — can resolve anytime before the window ends.
        </Text>
      ) : null}
    </Surface>
  );
}

/**
 * BetConfirmation — the satisfying micro-moment after you tap a side. It is an
 * estimate, not a fixed payout promise.
 */
function BetConfirmation({
  pending,
  format = money,
}: {
  pending: PendingBet;
  format?: (n: number) => string;
}) {
  const isYes = pending.side === "YES";
  const tint = isYes ? colors.yes : colors.no;
  const fill = isYes ? colors.alpha.yes : colors.alpha.no;
  const scale = useSharedValue(0.9);
  useEffect(() => {
    scale.value = withSequence(
      withSpring(1.04, spring.bouncy),
      withSpring(1, spring.smooth),
    );
  }, [scale]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      style={[
        styles.locked,
        { backgroundColor: fill, borderColor: tint },
        animStyle,
      ]}
    >
      <View style={[styles.lockedDot, { backgroundColor: tint }]} />
      <Text style={[styles.lockedText, { color: tint }]}>
        Bet {pending.side} · est. {multiple(pending.estimatedMult)}
      </Text>
      <Text style={styles.lockedStake}>{format(pending.stake)} in</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, gap: spacing.md },
  head: { gap: spacing.xs },
  question: {
    ...type.title,
    fontSize: 22,
    color: colors.textPrimary,
    lineHeight: 27,
    marginTop: 4,
  },
  subtitle: {
    ...type.caption,
    fontSize: 12.5,
    color: colors.textMuted,
    lineHeight: 17,
  },
  ringRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  btns: { flexDirection: "row", gap: spacing.md },
  locked: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  lockedDot: { width: 8, height: 8, borderRadius: 4 },
  lockedText: { ...type.subtitle, fontSize: 15, flex: 1 },
  lockedStake: { ...type.mono, fontSize: 13, color: colors.textSecondary },
  sat: {
    ...type.caption,
    fontSize: 12,
    color: colors.textFaint,
    marginTop: spacing.xs,
  },
});
