// CHAIN WALLET HERO — the REAL on-chain wallet view for the Wallet tab, shown
// when on-chain (Live) mode is connected. This is the embedded self-custodial
// Solana wallet: its USX balance, its deposit address, a devnet/localnet faucet,
// and a real withdraw.
//
// No play-money here. When chain mode is OFF the Wallet tab shows the play
// balance instead (WalletHero).
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Pressable, Surface, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { money } from "@/lib/format";
import { copyToClipboard } from "../platform";

export function ChainWalletHero({
  address,
  balanceUsd,
  airdropEnabled,
  onFund,
  onWithdraw,
  funding,
  fundDisabled = false,
  fundWaitSec = 0,
}: {
  address?: string;
  /** USX balance (the bettable balance), shown as the headline dollars. */
  balanceUsd: number;
  airdropEnabled: boolean;
  onFund: () => void;
  onWithdraw: () => void;
  funding: boolean;
  fundDisabled?: boolean;
  fundWaitSec?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!address) return;
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <Surface radius={radius.xl} style={styles.card}>
      <Text style={styles.balance} allowFontScaling={false}>
        {money(balanceUsd)}
      </Text>

      {/* Deposit address = the real on-ramp. Shown IN
          FULL (selectable, wrapping monospace) since this is the address the
          user copies/scans to receive funds — never truncate the receive addr. */}
      <Pressable onPress={copy} style={styles.addrRow} haptic="tap">
        <View style={{ flex: 1 }}>
          <Text style={styles.addrLabel}>DEPOSIT ADDRESS</Text>
          <Text style={styles.addr} selectable>
            {address ?? "—"}
          </Text>
        </View>
        <Text style={styles.copy}>{copied ? "copied ✓" : "copy"}</Text>
      </Pressable>

      <View style={styles.actions}>
        {airdropEnabled ? (
          <Button
            label={
              funding
                ? "Funding…"
                : fundDisabled && fundWaitSec > 0
                  ? `Wait ${fundWaitSec}s`
                  : "Fund (test SOL)"
            }
            variant="primary"
            size="md"
            loading={funding}
            onPress={onFund}
            disabled={fundDisabled || funding}
            style={styles.action}
          />
        ) : null}
        <Button
          label="Withdraw"
          variant="secondary"
          size="md"
          onPress={onWithdraw}
          disabled={balanceUsd <= 0}
          style={styles.action}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, gap: 6, overflow: "hidden" },
  balance: { ...type.display, fontSize: 44, color: colors.textPrimary, marginTop: spacing.sm },
  addrRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
  },
  addrLabel: { ...type.caption, fontSize: 10, color: colors.textMuted, letterSpacing: 1 },
  // Full base58 address: monospace, wraps across lines, selectable for copy.
  addr: { ...type.mono, fontSize: 13.5, lineHeight: 19, color: colors.textPrimary, marginTop: 3 },
  copy: { ...type.caption, fontSize: 12, color: colors.yes },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  action: { flex: 1 },
});
