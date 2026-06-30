import React, { useMemo } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { colors, spacing, type } from "@/theme";
import { FlatRow, MiniBadge, MonoStat, Overline, Pressable, Text } from "@/ui";

const openTx = (url?: string) => {
  if (url) Linking.openURL(url).catch(() => {});
};
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";
import { multiple } from "@/lib/format";
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
  // bet.delta is ALREADY the signed net (won ? payout - stake : -stake), so trust it directly.
  // (Previously this re-subtracted the stake whenever bet.delta > bet.stake — i.e. any win above
  // 2.0x — making the row read one stake short of the balance credit and the session P&L pill.)
  if (bet) return bet.delta;
  return undefined;
}

/** Badge fill + on-colour, coloured by the user's RESULT (not the raw outcome). */
function badgeColors(result: ReturnType<typeof userResult>): { bg: string; fg: string } {
  if (result === "won") return { bg: colors.yes, fg: colors.onYes };
  if (result === "lost") return { bg: colors.no, fg: "#ffffff" };
  if (result === "void") return { bg: colors.cyan, fg: "#04122e" };
  return { bg: colors.surface2, fg: colors.textMuted };
}

/**
 * Your session's settled markets — dense flat rows: question · outcome badge · net P/L.
 * A 2px left stripe (green win / red loss) on markets you bet; nothing you didn't touch
 * reads as a result. No pool readout — just what happened and what it cost you.
 */
export function ClosedMarketsList({
  markets,
  userBets = [],
  catchingUp = false,
  onClaim,
}: {
  markets: ClosedMarketVM[];
  userBets?: BetRow[];
  catchingUp?: boolean;
  /** Claim a resolved on-chain bet — tapping a claimable row IS the claim (no button). */
  onClaim?: (marketId: string) => void;
}) {
  const { signedFormat } = useDisplayBalance();
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
      <Overline size={8} style={styles.header}>
        {header}
      </Overline>
      <View style={styles.list}>
        {markets.map((m) => {
          const bet = betByMarket.get(m.marketId);
          const pending = m.pending === true; // on-chain bet placed, not yet resolved
          const result = pending ? "none" : userResult(m, bet);
          const badge = pending ? { bg: colors.cyan, fg: "#04122e" } : badgeColors(result);
          const label = pending ? "LIVE" : resultBadgeLabel(m.outcome, m.kind, m.question);
          const side = m.userSide ?? bet?.side;
          const sideLabel = side ? sideDisplayLabel(side, m.kind, m.question) : null;
          const net = pending ? undefined : sessionNet(m, bet, result);
          const accent =
            result === "won" ? colors.yes : result === "lost" ? colors.no : undefined;
          const claimable = !!m.claimable && !!onClaim && !m.claiming;
          // on-chain rows carry a tx link + a claim state (claiming / claimed / tap-to-claim)
          const hasChainRow = !!(m.txUrl || m.claimUrl || claimable || m.claiming);

          const inner = (
            <FlatRow faint compact accent={accent}>
              <View style={styles.main}>
                <Text style={styles.question} numberOfLines={1}>
                  {m.question}
                </Text>
                {sideLabel ? (
                  <Overline size={8.5} style={styles.youLine}>
                    YOU · {sideLabel}
                    {pending && m.userLiveMult && m.userLiveMult > 0
                      ? ` · ${multiple(m.userLiveMult)} live`
                      : ""}
                  </Overline>
                ) : null}
                {result === "void" && m.voidReason ? (
                  <Overline size={8.5} style={styles.voidLine}>
                    {m.voidReason}
                  </Overline>
                ) : null}
                {hasChainRow ? (
                  <View style={styles.chainRow}>
                    {m.txUrl ? (
                      <Text style={styles.txLink} onPress={() => openTx(m.txUrl)}>
                        view tx ↗
                      </Text>
                    ) : null}
                    {m.claiming ? (
                      <Text style={styles.claimHint}>claiming…</Text>
                    ) : m.claimUrl ? (
                      <Text
                        style={[styles.claimHint, { color: colors.gold }]}
                        onPress={() => openTx(m.claimUrl)}
                      >
                        claimed ✓
                      </Text>
                    ) : claimable ? (
                      <Text style={[styles.claimHint, { color: colors.yes }]}>tap to claim</Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={styles.result}>
                <View style={styles.badgeCol}>
                  <MiniBadge label={label} bg={badge.bg} fg={badge.fg} />
                </View>
                <MonoStat
                  size={12}
                  color={
                    net !== undefined && result !== "none"
                      ? net > 0
                        ? colors.yes
                        : net < 0
                          ? colors.no
                          : colors.textFaint
                      : colors.textFaint
                  }
                  style={styles.net}
                >
                  {pending
                    ? "…"
                    : net !== undefined && result !== "none"
                      ? result === "void"
                        ? "void"
                        : signedFormat(net)
                      : ""}
                </MonoStat>
              </View>
            </FlatRow>
          );

          // A claimable on-chain row IS the claim — tap the row (no separate button).
          return claimable ? (
            <Pressable key={m.marketId} onPress={() => onClaim!(m.marketId)} haptic="tap">
              {inner}
            </Pressable>
          ) : (
            <View key={m.marketId}>{inner}</View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  header: { paddingHorizontal: spacing.xs },
  list: { gap: spacing.xs },
  main: { flex: 1, gap: 2 },
  question: { ...type.caption, fontSize: 12, color: colors.textMuted, lineHeight: 15 },
  youLine: { letterSpacing: 0.4, color: colors.textFaint },
  voidLine: { letterSpacing: 0.3, color: colors.cyan },
  // Right cluster: badge + net share one vertically-centred row so they sit on a clean
  // baseline (the MiniBadge's own alignSelf:flex-start no longer pulls it to the top), and
  // the fixed-width columns keep badges + nets aligned down the whole list.
  result: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badgeCol: { minWidth: 46, alignItems: "flex-start" },
  net: { minWidth: 48, textAlign: "right" },
  chainRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center", marginTop: 2 },
  txLink: { ...type.caption, fontSize: 10, color: colors.cyan },
  claimHint: { ...type.caption, fontSize: 10, color: colors.textFaint },
});
