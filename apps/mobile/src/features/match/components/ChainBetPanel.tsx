// CHAIN BET PANEL — the on-chain RECEIPT inside the live match.
//
// Shows ONLY after a real bet: side, stake, the indicative quote at tap time, the
// bet tx (tap -> Solana Explorer), and once the market resolves a Claim button
// that pays the final proportional pool share on-chain. The wallet itself
// (balance / address / fund) lives in the Wallet tab + the header balance.
import React from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Banner, Button, Pressable, Surface, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { money, multiple } from "@/lib/format";
import { SOL_PER_UNIT } from "@/features/chain/useDisplayBalance";
import type { UseChain } from "@/features/chain/useChain";
import type { UseChainBet } from "../useChainBet";

const openUrl = (url?: string) => {
  if (url) Linking.openURL(url).catch(() => {});
};

export function ChainBetPanel({
  chain,
  cb,
}: {
  chain: UseChain;
  cb: UseChainBet;
}) {
  // Only render when there's something to show — a placed bet or an error.
  if (!chain.configured || (!cb.bet && !cb.error)) return null;

  return (
    <View style={styles.wrap}>
      {cb.error ? <Banner tone="danger" message={cb.error} /> : null}
      {cb.bet ? <Receipt cb={cb} cluster={chain.cluster} /> : null}
    </View>
  );
}

function Receipt({
  cb,
  cluster,
}: {
  cb: UseChainBet;
  cluster: UseChain["cluster"];
}) {
  const b = cb.bet!;
  const tint = b.side === "YES" ? colors.yes : colors.no;
  return (
    <Surface radius={radius.lg} borderColor={tint} style={styles.receipt}>
      <View style={styles.row}>
        <Text style={[styles.side, { color: tint }]}>{b.side}</Text>
        <Text style={styles.stake}>
          {money(b.stakeSol / SOL_PER_UNIT)} @ est. {multiple(b.estimatedMultiple)}
        </Text>
      </View>
      <Text style={styles.q} numberOfLines={2}>
        {b.question}
      </Text>

      <Pressable onPress={() => openUrl(b.betUrl)} style={styles.txLink}>
        <Text style={styles.txLabel}>● bet placed on-chain</Text>
        <Text style={styles.txView}>view tx ↗</Text>
      </Pressable>

      {b.claimSignature ? (
        <Pressable onPress={() => openUrl(b.claimUrl)} style={styles.txLink}>
          <Text style={[styles.txLabel, { color: colors.gold }]}>
            ✓ settled on-chain — winnings (if any) paid to your wallet
          </Text>
          <Text style={styles.txView}>view tx ↗</Text>
        </Pressable>
      ) : b.claimable ? (
        <Button
          label="Claim winnings"
          variant="primary"
          size="md"
          fullWidth
          loading={b.claiming}
          onPress={cb.claimChainBet}
          style={styles.claimBtn}
        />
      ) : (
        <Text style={styles.waiting}>
          Bet placed — payout floats until betting closes. (cluster: {cluster})
        </Text>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  stripLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  addr: { ...type.mono, fontSize: 12.5, color: colors.textPrimary },
  bal: { ...type.caption, fontSize: 11, color: colors.textMuted },
  receipt: { padding: spacing.md, gap: 6 },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  side: { ...type.display, fontSize: 18, letterSpacing: 1 },
  stake: { ...type.mono, fontSize: 13, color: colors.textPrimary },
  q: { ...type.caption, fontSize: 12.5, color: colors.textMuted },
  txLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  txLabel: { ...type.caption, fontSize: 12, color: colors.yes },
  txView: { ...type.caption, fontSize: 12, color: colors.textMuted },
  claimBtn: { marginTop: 6 },
  waiting: { ...type.caption, fontSize: 11.5, color: colors.textMuted, marginTop: 2 },
});
