import React from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { signedMoney } from "@/lib/format";
import type { TransactionRow } from "@/state/types";

/**
 * ActivityRow — one money-movement row in the wallet ledger. A tinted glyph disc
 * (lime ↓ for a deposit, pink ↑ for a withdrawal), a human title + method/time
 * caption, and the signed amount in tabular display (lime for +, pink for −). A
 * tiny status dot marks pending/failed rows so an in-flight ramp reads clearly.
 *
 * Pure presentational; takes a {@link TransactionRow} from the store.
 */
const METHOD_LABEL: Record<string, string> = {
  sandbox: "Demo faucet",
  card: "Card",
  apple_pay: "Apple Pay",
  crypto: "Crypto",
  bank: "Bank / card",
};

const STATUS_TONE: Record<string, string> = {
  pending: colors.gold,
  complete: colors.yes,
  failed: colors.no,
};

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 45) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function ActivityRow({ row }: { row: TransactionRow }) {
  const isDeposit = row.type === "deposit";
  const method = row.method ?? row.destination ?? "sandbox";
  const methodLabel = METHOD_LABEL[method] ?? method;
  const title = isDeposit ? "Added cash" : "Cashed out";
  const amountColor = isDeposit ? colors.yes : colors.no;

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.disc,
          { backgroundColor: isDeposit ? colors.alpha.yes : colors.alpha.no },
        ]}
      >
        <Text style={[styles.glyph, { color: amountColor }]}>
          {isDeposit ? "↓" : "↑"}
        </Text>
      </View>

      <View style={styles.body}>
        <Text style={[type.bodyStrong, styles.title]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.metaRow}>
          {row.status !== "complete" ? (
            <View
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_TONE[row.status] },
              ]}
            />
          ) : null}
          <Text style={[type.caption, styles.meta]} numberOfLines={1}>
            {row.status === "pending"
              ? "Pending"
              : row.status === "failed"
                ? "Failed"
                : methodLabel}
            {row.status === "complete" ? ` · ${timeAgo(row.at)}` : ""}
          </Text>
        </View>
      </View>

      <Text style={[type.mono, styles.amount, { color: amountColor }]}>
        {signedMoney(row.delta)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  disc: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: { fontSize: 20, fontWeight: "700", lineHeight: 22 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  meta: { color: colors.textMuted },
  amount: { fontSize: 16 },
});
