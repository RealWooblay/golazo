import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Banner, Chip, Pressable, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { haptics } from "@/ui/haptics";
import { QRCode } from "../qr/QRCode";
import { solanaPayUri } from "../address";
import { copyToClipboard } from "../platform";
import { Surface } from "./Surface";

/**
 * DepositAddressCard — the "deposit crypto" panel. Renders the user's Solana
 * deposit address as a scannable Solana Pay QR (dependency-free {@link QRCode}),
 * the shortened address with a one-tap copy, and a clear label for whether this
 * is a real connected wallet or the sandbox demo address.
 *
 * The QR encodes a `solana:<address>` Pay URI (open amount) so any Solana wallet
 * can scan it. Copy uses the web-safe clipboard shim. In sandbox mode the parent
 * also wires a "simulate incoming" affordance to demo the auto-credit.
 */
export interface DepositAddressCardProps {
  address: string;
  /** True = a real connected wallet; false = sandbox demo address. */
  live: boolean;
  /** Network label, default "Solana". */
  network?: string;
}

export function DepositAddressCard({
  address,
  live,
  network = "Solana",
}: DepositAddressCardProps) {
  const [copied, setCopied] = useState(false);
  const payUri = solanaPayUri({
    recipient: address,
    label: "GOLAZO",
    message: "Add cash",
  });

  const copy = async () => {
    const ok = await copyToClipboard(address);
    haptics.selection();
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <View style={styles.root}>
      <Surface level={1} radius="xl" style={styles.qrCard}>
        <View style={styles.qrFrame}>
          <QRCode
            value={payUri}
            size={196}
            color={colors.bg}
            background="#f4f6fb"
            ecLevel="M"
          />
        </View>
        <View style={styles.netRow}>
          <Chip label={network} tone="info" />
          <Chip
            label={live ? "Your wallet" : "Demo address"}
            tone={live ? "live" : "neutral"}
          />
        </View>
      </Surface>

      <Pressable onPress={copy} haptic={null} scaleTo={0.98}>
        <Surface
          level={1}
          radius="lg"
          borderColor={copied ? colors.glow.yesSoft : colors.hairline}
          glow={copied ? "yes" : "none"}
          style={styles.addrRow}
        >
          <View style={styles.addrBody}>
            <Text style={[type.overline, styles.addrLabel]}>
              {network} address
            </Text>
            {/* Deposit/receive address shown IN FULL (wrapping, selectable) —
                never truncate the address funds are sent to. */}
            <Text style={[type.mono, styles.addr]} selectable>
              {address}
            </Text>
          </View>
          <View
            style={[
              styles.copyTag,
              copied && { borderColor: colors.glow.yesSoft },
            ]}
          >
            <Text
              style={[
                type.overline,
                { color: copied ? colors.yes : colors.cyan },
              ]}
            >
              {copied ? "Copied" : "Copy"}
            </Text>
          </View>
        </Surface>
      </Pressable>

      {!live ? (
        <Banner
          tone="info"
          title="Demo deposit"
          message="This is a demo address. Connect a wallet to deposit crypto."
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg },
  qrCard: { alignItems: "center", padding: spacing.xl, gap: spacing.lg },
  qrFrame: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: "#f4f6fb",
  },
  netRow: { flexDirection: "row", gap: spacing.sm },
  addrRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    gap: spacing.md,
  },
  addrBody: { flex: 1, gap: 2 },
  addrLabel: { color: colors.textFaint },
  addr: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  copyTag: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.glow.cyanSoft,
  },
});
