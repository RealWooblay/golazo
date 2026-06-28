import React from "react";
import { StyleSheet, View } from "react-native";
import { Divider, EmptyState } from "@/ui";
import { spacing } from "@/theme";
import type { TransactionRow } from "@/state/types";
import { ActivityRow } from "./ActivityRow";
import { Surface } from "./Surface";

/**
 * ActivityList — the wallet's money-movement ledger. Wraps the transaction rows
 * in a single layered Surface with hairline dividers between them, capped to
 * `limit` recent rows. When there are none it shows an on-brand empty state with
 * a "Add cash" CTA so a fresh wallet still has somewhere to go.
 *
 * Only renders transactions (deposits/withdrawals) — bet history lives on the
 * Profile screen. Newest first (the store already orders the ledger that way).
 */
export function ActivityList({
  rows,
  limit = 8,
  onAddCash,
}: {
  rows: TransactionRow[];
  limit?: number;
  onAddCash?: () => void;
}) {
  if (rows.length === 0) {
    return (
      <Surface level={1} radius="lg" style={styles.emptyCard}>
        <EmptyState
          icon=""
          title="No movements yet"
          body="Deposits and withdrawals appear here."
          ctaLabel={onAddCash ? "Add cash" : undefined}
          onCta={onAddCash}
        />
      </Surface>
    );
  }

  const shown = rows.slice(0, limit);

  return (
    <Surface level={1} radius="lg" style={styles.card}>
      {shown.map((row, i) => (
        <View key={row.id}>
          <ActivityRow row={row} />
          {i < shown.length - 1 ? <Divider margin={0} /> : null}
        </View>
      ))}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  emptyCard: { paddingVertical: spacing.sm },
});
