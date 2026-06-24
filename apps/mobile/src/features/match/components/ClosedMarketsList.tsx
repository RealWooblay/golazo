import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import type { BetRow, ClosedMarketVM } from "@/state/types";
import { resultBadgeLabel, sideDisplayLabel } from "../marketMeta";

function userResult(
  m: ClosedMarketVM,
  bet?: BetRow,
): "won" | "lost" | "void" | "none" {
  const side = m.userSide ?? bet?.side;
  if (!side) return "none";
  if (m.outcome === "VOID" || bet?.outcome === "VOID") return "void";
  if (side === m.outcome) return "won";
  return "lost";
}

/** Net P/L for the session row — stake captured at settle, not ledger guesswork. */
function sessionNet(
  m: ClosedMarketVM,
  bet: BetRow | undefined,
  result: ReturnType<typeof userResult>,
): number | undefined {
  if (result === "none") return undefined;
  if (m.userDelta !== undefined) return m.userDelta;
  if (result === "void") return 0;
  const stake = m.userStake ?? bet?.stake;
  if (result === "lost") return stake != null ? -stake : bet?.delta;
  if (bet) {
    if (bet.stake > 0 && bet.delta > bet.stake) return bet.delta - bet.stake;
    return bet.delta;
  }
  return undefined;
}

/**
 * Your session's settled markets — slim rows with outcome badges. Markets you bet
 * on get a green (win) or red (loss) border; everything else stays neutral.
 */
export function ClosedMarketsList({
  markets,
  userBets = [],
  catchingUp = false,
}: {
  markets: ClosedMarketVM[];
  /** Settled bets on this match — used for borders, side labels, and W/L header. */
  userBets?: BetRow[];
  catchingUp?: boolean;
}) {
  const { format, signedFormat } = useDisplayBalance();
  const betByMarket = useMemo(
    () => new Map(userBets.map((b) => [b.marketId, b] as const)),
    [userBets],
  );

  const sessionStats = useMemo(() => {
    let wins = 0;
    let losses = 0;
    for (const m of markets) {
      const r = userResult(m, betByMarket.get(m.marketId));
      if (r === "won") wins += 1;
      else if (r === "lost") losses += 1;
    }
    return { wins, losses };
  }, [markets, betByMarket]);

  if (markets.length === 0) return null;

  const played = sessionStats.wins + sessionStats.losses;
  const header =
    played > 0
      ? `YOUR SESSION · ${sessionStats.wins}W ${sessionStats.losses}L`
      : catchingUp
        ? "YOUR SESSION · catching up"
        : "YOUR SESSION";

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>{header}</Text>
      <View style={styles.list}>
        {markets.map((m) => {
          const bet = betByMarket.get(m.marketId);
          const result = userResult(m, bet);
          // Badge = the market's verdict (YES/NO/team/VOID), COLOURED BY THE USER'S RESULT
          // (won = green, lost = red, void = cyan) so it agrees with the row border. Markets
          // you didn't bet stay neutral — a NO you never touched shouldn't read as a loss.
          const tint =
            result === "won"
              ? colors.yes
              : result === "lost"
                ? colors.no
                : result === "void"
                  ? colors.cyan
                  : colors.textFaint;
          const label = resultBadgeLabel(m.outcome, m.question);
          const side = m.userSide ?? bet?.side;
          const sideLabel = side
            ? sideDisplayLabel(side, m.kind, m.question)
            : null;
          const net = sessionNet(m, bet, result);
          const rowBorder =
            result === "won"
              ? styles.rowWon
              : result === "lost"
                ? styles.rowLost
                : null;

          return (
            <View key={m.marketId} style={[styles.row, rowBorder]}>
              <View style={styles.main}>
                <Text style={[styles.question, side ? styles.questionMine : null]} numberOfLines={1}>
                  {m.question}
                </Text>
                {sideLabel ? (
                  <Text style={styles.youLine} numberOfLines={1}>
                    You · {sideLabel}
                    {net !== undefined && result !== "none"
                      ? result === "void"
                        ? " · refund"
                        : ` · ${signedFormat(net)}`
                      : ""}
                  </Text>
                ) : null}
              </View>
              <View style={styles.meta}>
                <View style={[styles.badge, { backgroundColor: tint }]}>
                  <Text style={styles.badgeText}>{label}</Text>
                </View>
                <Text style={styles.pool}>{format(m.poolTotal)}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  header: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.2,
    paddingHorizontal: spacing.xs,
  },
  list: { gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  rowWon: { borderColor: colors.glow.yesSoft },
  rowLost: { borderColor: colors.glow.noSoft },
  main: { flex: 1, gap: 2 },
  question: {
    ...type.caption,
    fontSize: 11.5,
    color: colors.textMuted,
    lineHeight: 14,
  },
  questionMine: { color: colors.textSecondary },
  youLine: {
    ...type.overline,
    fontSize: 8.5,
    color: colors.textFaint,
    letterSpacing: 0.4,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    minWidth: 28,
    alignItems: "center",
  },
  badgeText: {
    ...type.overline,
    fontSize: 8,
    color: "#0a0b0f",
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  pool: {
    ...type.mono,
    fontSize: 10,
    color: colors.textFaint,
    minWidth: 36,
    textAlign: "right",
  },
});
