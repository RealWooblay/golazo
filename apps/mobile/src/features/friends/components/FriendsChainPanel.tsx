import React from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Banner, Button, Pressable, Surface, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { money, multiple } from "@/lib/format";
import { SOL_PER_UNIT } from "@/features/chain/useDisplayBalance";
import type { ChainBetVM } from "@/features/match/chainBetTypes";

const openUrl = (url?: string) => {
  if (url) Linking.openURL(url).catch(() => {});
};

/** On-chain bet receipts for friends room markets (place + claim). */
export function FriendsChainPanel({
  bets,
  error,
  onClaim,
}: {
  bets: ChainBetVM[];
  error: string | null;
  onClaim: (marketId: string) => void;
}) {
  if (!error && bets.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {error ? <Banner tone="danger" message={error} /> : null}
      {bets.map((b) => (
        <Receipt key={b.offChainMarketId} bet={b} onClaim={onClaim} />
      ))}
    </View>
  );
}

function Receipt({
  bet,
  onClaim,
}: {
  bet: ChainBetVM;
  onClaim: (marketId: string) => void;
}) {
  const tint = bet.side === "YES" ? colors.yes : colors.no;
  const result =
    bet.resolvedOutcome && bet.resolvedOutcome !== "VOID"
      ? `Result: ${bet.resolvedOutcome} · ${bet.won ? "your side won" : "your side lost"}`
      : bet.resolvedOutcome === "VOID"
        ? "Result: VOID · stake refunded"
        : null;
  return (
    <Surface radius={radius.lg} borderColor={tint} style={styles.receipt}>
      <View style={styles.row}>
        <Text style={[styles.side, { color: tint }]}>{bet.side}</Text>
        <Text style={styles.stake}>
          {money(bet.stakeSol / SOL_PER_UNIT)} @ est.{" "}
          {multiple(bet.estimatedMultiple)}
        </Text>
      </View>
      <Text style={styles.q} numberOfLines={2}>
        {bet.question}
      </Text>
      <Pressable onPress={() => openUrl(bet.betUrl)} style={styles.txLink}>
        <Text style={styles.txLabel}>● bet on-chain</Text>
        <Text style={styles.txView}>view tx ↗</Text>
      </Pressable>
      {result ? <Text style={styles.result}>{result}</Text> : null}
      {bet.claimSignature ? (
        <Pressable onPress={() => openUrl(bet.claimUrl)} style={styles.txLink}>
          <Text style={[styles.txLabel, { color: colors.gold }]}>
            ✓ claimed to wallet
          </Text>
          <Text style={styles.txView}>view tx ↗</Text>
        </Pressable>
      ) : bet.claimable ? (
        <Button
          label={bet.won ? "Claim payout" : "Claim settlement"}
          variant="primary"
          size="md"
          fullWidth
          loading={bet.claiming}
          onPress={() => onClaim(bet.offChainMarketId)}
          style={styles.claimBtn}
        />
      ) : (
        <Text style={styles.wait}>Waiting for market to resolve…</Text>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  receipt: { padding: spacing.md, gap: spacing.xs },
  row: { flexDirection: "row", justifyContent: "space-between" },
  side: { ...type.bodyStrong, fontSize: 15 },
  stake: { ...type.mono, fontSize: 13, color: colors.textMuted },
  q: { ...type.caption, color: colors.textPrimary },
  txLink: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  txLabel: { ...type.caption, color: colors.cyan, fontSize: 11 },
  txView: { ...type.caption, color: colors.textFaint, fontSize: 11 },
  wait: { ...type.caption, color: colors.textFaint, fontSize: 11 },
  result: { ...type.caption, color: colors.textSecondary, fontSize: 11 },
  claimBtn: { marginTop: spacing.xs },
});
