// OWNED BY: profile agent.
//
// The Profile tab: identity (editable display name), lifetime stats derived from
// the ledger, the unified history (bets + transactions, filterable), and settings
// (sound, haptics, offline/live mode + live feed URL, reset balance, how-it-works).
// All state flows through the store (@/state). Web-safe — reuses @/ui + the
// profile feature components, no new deps.
import React, { useCallback, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Chip, EmptyState, Screen, Sheet, Text } from "@/ui";
import { haptics } from "@/ui/haptics";
import {
  LedgerRow,
  LinkRow,
  ProfileHero,
  SettingsGroup,
  ToggleRow,
  filterLedger,
  lifetimeStats,
  FeedOpsPanel,
  useFeedOps,
  type LedgerFilter,
} from "@/features/profile";
import { Entrance } from "@/features/_shared/primitives";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { useDisplayBalance } from "@/features/chain/useDisplayBalance";

const FILTERS: { value: LedgerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "bets", label: "Bets" },
  { value: "cash", label: "Cash" },
];

export default function ProfileTab() {
  const router = useRouter();
  const store = useStore();
  const hx = store.session.hapticsOn;

  const bal = useDisplayBalance(); // real SOL in chain mode, play $ otherwise
  const stats = useMemo(() => lifetimeStats(store.bets), [store.bets]);

  const [filter, setFilter] = useState<LedgerFilter>("all");
  const ledger = useMemo(
    () => filterLedger(store.history, filter),
    [store.history, filter],
  );
  // History is a glance, not an archive — cap the ledger to the 5 most recent
  // rows. (filterLedger returns newest-first.)
  const HISTORY_CAP = 5;
  const visibleLedger = useMemo(
    () => ledger.slice(0, HISTORY_CAP),
    [ledger],
  );

  // Name editor sheet
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(store.session.displayName ?? "");
  const openEdit = () => {
    setDraftName(store.session.displayName ?? "");
    setEditing(true);
  };
  const saveName = () => {
    store.setName(draftName.trim());
    if (hx) haptics.select();
    setEditing(false);
  };

  // Reset confirmation sheet
  const [confirmReset, setConfirmReset] = useState(false);
  const doReset = useCallback(() => {
    store.reset();
    if (hx) haptics.heavy();
    setConfirmReset(false);
  }, [store, hx]);

  // Profile is mode-independent: the page reads identically in every money/live
  // mode. The one exception is the live-feed status line at the very bottom,
  // which only has anything to report while the live feed is connected.
  const goLive = store.session.mode === "live";
  const feedOps = useFeedOps(goLive);

  // Load a fresh DEMO game: flip to the offline simulator (play money) and open
  // the demo match. The sim starts 0-0 and auto-resets, so it's always fresh.
  const loadDemo = useCallback(() => {
    store.setMode("offline");
    if (hx) haptics.tap();
    router.push("/match/sim-arg-fra");
  }, [store, hx, router]);

  return (
    <Screen vignette="gold">
      <UnifiedHeader variant="screen" title="Profile" />

      <ProfileHero
        name={store.session.displayName ?? ""}
        balance={bal.amount}
        balanceFormat={bal.format}
        stats={stats}
        onEditName={openEdit}
      />

      {/* History ledger */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <View style={styles.historyTitle}>
            <Text preset="subtitle">History</Text>
            {ledger.length > HISTORY_CAP ? (
              <Text preset="caption" faint>
                last 5
              </Text>
            ) : null}
          </View>
          <View style={styles.filters}>
            {FILTERS.map((f) => (
              <Chip
                key={f.value}
                label={f.label}
                // Neutral tone keeps the filter legible: the accent tones rendered
                // same-hue text over a 12% tint of that same hue (lime-on-lime /
                // cyan-on-cyan), so the active chip read as invisible. Neutral gives
                // muted text on a distinct fill — the active chip stays obvious.
                tone="neutral"
                selected={filter === f.value}
                onPress={() => setFilter(f.value)}
              />
            ))}
          </View>
        </View>

        {ledger.length === 0 ? (
          <View style={styles.emptyWrap}>
            <EmptyState
              icon=""
              title={filter === "cash" ? "No cash moves yet" : "No plays yet"}
              body={
                filter === "cash"
                  ? "Deposits and withdrawals will show up here."
                  : "Your bets land here once you've played a market."
              }
            />
          </View>
        ) : (
          <View style={styles.ledger}>
            <View pointerEvents="none" style={styles.topHighlight} />
            {visibleLedger.map((item, i) => (
              <Entrance key={item.id} delay={Math.min(i, 8) * 24}>
                {i > 0 ? <View style={styles.rowSep} /> : null}
                <LedgerRow item={item} />
              </Entrance>
            ))}
          </View>
        )}
      </View>

      {/* Settings */}
      <View style={styles.section}>
        <SettingsGroup title="PREFERENCES">
          {/* Sound toggle removed — no audio is implemented, so it was a dead
              switch (and this is a betting tool, not a hype feed). */}
          <ToggleRow
            glyph=""
            title="Haptics"
            sub="Tactile feedback on taps and wins"
            value={store.session.hapticsOn}
            onChange={(v) => store.setSession({ hapticsOn: v })}
            hapticsEnabled={hx}
          />
        </SettingsGroup>

        <View style={{ height: spacing.lg }} />

        <SettingsGroup title="MORE">
          <LinkRow
            glyph=""
            title="Demo match"
            sub="Offline sim — practice the loop without the live feed"
            onPress={loadDemo}
            hapticsEnabled={hx}
          />
          <LinkRow
            glyph=""
            title="How GOLAZO works"
            sub="The mechanic in 30 seconds"
            onPress={() => router.push("/how-it-works")}
            hapticsEnabled={hx}
          />
          <LinkRow
            glyph=""
            title="Add cash"
            sub="Top up your play-money balance"
            onPress={() => router.push("/(modals)/deposit")}
            hapticsEnabled={hx}
          />
          <LinkRow
            glyph="↺"
            title="Reset balance & history"
            sub="Clear local history (wallet & rank id stay)"
            onPress={() => setConfirmReset(true)}
            hapticsEnabled={hx}
            danger
          />
        </SettingsGroup>
      </View>

      {goLive ? (
        <FeedOpsPanel
          health={feedOps.health}
          metrics={feedOps.metrics}
          error={feedOps.error}
          onRefresh={feedOps.refresh}
        />
      ) : null}

      {/* Name editor */}
      <Sheet open={editing} onClose={() => setEditing(false)}>
        <View style={styles.sheet}>
          <Text preset="subtitle">Your handle</Text>
          <Text preset="caption" muted>
            How you show up on the leaderboard later. Optional.
          </Text>
          <TextInput
            value={draftName}
            onChangeText={setDraftName}
            placeholder="Pick a handle"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            maxLength={20}
            autoCapitalize="words"
            autoCorrect={false}
            autoFocus
            selectionColor={colors.yes}
            onSubmitEditing={saveName}
            returnKeyType="done"
          />
          <Button
            label="Save"
            onPress={saveName}
            variant="primary"
            fullWidth
            glow
          />
        </View>
      </Sheet>

      {/* Reset confirmation */}
      <Sheet open={confirmReset} onClose={() => setConfirmReset(false)}>
        <View style={styles.sheet}>
          <Text preset="subtitle">Reset everything?</Text>
          <Text preset="body" muted>
            This wipes your local bet history and sandbox balance. Your wallet
            address and paper-trade rank id are kept.
          </Text>
          <View style={styles.confirmBtns}>
            <Button
              label="Cancel"
              onPress={() => setConfirmReset(false)}
              variant="ghost"
              fullWidth
              style={styles.confirmBtn}
            />
            <Button
              label="Reset"
              onPress={doReset}
              variant="danger"
              fullWidth
              glow
              style={styles.confirmBtn}
            />
          </View>
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.xxl },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  historyTitle: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
  },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexShrink: 1,
    gap: spacing.xs,
  },
  ledger: {
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
    zIndex: 1,
  },
  rowSep: {
    height: 1,
    backgroundColor: colors.hairlineSoft,
    marginHorizontal: spacing.md,
  },
  emptyWrap: {
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
  },
  sheet: { gap: spacing.md, paddingBottom: spacing.md },
  input: {
    ...type.subtitle,
    color: colors.textPrimary,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
  },
  confirmBtns: { flexDirection: "row", gap: spacing.md, marginTop: spacing.xs },
  confirmBtn: { flex: 1 },
});
