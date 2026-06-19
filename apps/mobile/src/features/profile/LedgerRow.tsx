import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { multiple, signedMoney } from "@/lib/format";
import { Text } from "@/ui";
import type { BetRow, HistoryItem, TransactionRow } from "@/state";
import { relativeTime } from "./stats";

/**
 * LedgerRow — one row of the unified history ledger. Renders either a settled bet
 * or a money transaction (discriminated on `kind`), each with a tasteful leading
 * glyph, a primary/secondary line, a signed delta on the right (green win / red
 * loss / muted void or withdrawal), and a relative timestamp.
 */
export function LedgerRow({ item }: { item: HistoryItem }) {
  return item.kind === "bet" ? (
    <BetLedgerRow row={item} />
  ) : (
    <TxnLedgerRow row={item} />
  );
}

function BetLedgerRow({ row }: { row: BetRow }) {
  const isVoid = !row.won && row.delta === 0;
  const sideYes = row.side === "YES";
  const deltaColor = row.won
    ? colors.yes
    : isVoid
      ? colors.textMuted
      : colors.no;
  const outcomeLabel = isVoid ? "VOID" : row.won ? "WON" : "LOST";
  const outcomeTone = isVoid ? colors.gold : row.won ? colors.yes : colors.no;

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.glyph,
          {
            backgroundColor: sideYes ? colors.alpha.yes : colors.alpha.no,
            borderColor: sideYes
              ? "rgba(0,229,138,0.4)"
              : "rgba(255,77,109,0.4)",
          },
        ]}
      >
        <Text
          style={[
            styles.glyphText,
            { color: sideYes ? colors.yes : colors.no },
          ]}
        >
          {row.side}
        </Text>
      </View>

      <View style={styles.body}>
        <Text preset="bodyStrong" numberOfLines={1} style={styles.title}>
          {row.question || row.label}
        </Text>
        <View style={styles.subRow}>
          <View style={[styles.outChip, { borderColor: outcomeTone }]}>
            <Text style={[styles.outText, { color: outcomeTone }]}>
              {outcomeLabel}
            </Text>
          </View>
          {row.payoutMult > 0 ? (
            <Text style={styles.sub}>final {multiple(row.payoutMult)}</Text>
          ) : null}
          <Text style={styles.subDim}>· {relativeTime(row.at)}</Text>
        </View>
      </View>

      <Text
        style={[styles.delta, { color: deltaColor }]}
        allowFontScaling={false}
      >
        {isVoid ? "$0" : signedMoney(row.delta)}
      </Text>
    </View>
  );
}

function TxnLedgerRow({ row }: { row: TransactionRow }) {
  const isDeposit = row.type === "deposit";
  const accent = isDeposit ? colors.cyan : colors.textPrimary;
  const dest = isDeposit ? methodLabel(row) : destLabel(row);

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.glyph,
          styles.txnGlyph,
          { borderColor: isDeposit ? "rgba(22,198,255,0.4)" : colors.hairline },
        ]}
      >
        <View
          style={[
            styles.arrow,
            isDeposit
              ? { borderBottomWidth: 8, borderBottomColor: colors.cyan }
              : { borderTopWidth: 8, borderTopColor: colors.textMuted },
          ]}
        />
      </View>

      <View style={styles.body}>
        <Text preset="bodyStrong" numberOfLines={1} style={styles.title}>
          {isDeposit ? "Deposit" : "Withdrawal"}
        </Text>
        <View style={styles.subRow}>
          <Text style={styles.sub}>{dest}</Text>
          <Text style={styles.subDim}>· {relativeTime(row.at)}</Text>
          {row.status !== "complete" ? (
            <Text
              style={[
                styles.subDim,
                { color: row.status === "failed" ? colors.no : colors.gold },
              ]}
            >
              · {row.status}
            </Text>
          ) : null}
        </View>
      </View>

      <Text
        style={[
          styles.delta,
          { color: isDeposit ? colors.cyan : colors.textSecondary },
        ]}
        allowFontScaling={false}
      >
        {signedMoney(row.delta)}
      </Text>
    </View>
  );
}

function methodLabel(row: TransactionRow): string {
  switch (row.method) {
    case "card":
      return "Card";
    case "crypto":
      return "Crypto";
    case "apple_pay":
      return "Apple Pay";
    case "sandbox":
    default:
      return "Sandbox faucet";
  }
}
function destLabel(row: TransactionRow): string {
  switch (row.destination) {
    case "bank":
      return "Bank";
    case "crypto":
      return "Crypto wallet";
    case "sandbox":
    default:
      return "Sandbox";
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  glyphText: { ...type.overline, fontSize: 10 },
  txnGlyph: { backgroundColor: colors.surface2 },
  arrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  body: { flex: 1, gap: 3 },
  title: { color: colors.textPrimary },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  outChip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  outText: { ...type.overline, fontSize: 8 },
  sub: { ...type.caption, color: colors.textSecondary, fontSize: 11 },
  subDim: { ...type.caption, color: colors.textFaint, fontSize: 11 },
  delta: { ...type.mono, fontSize: 16 },
});
