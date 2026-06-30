// OWNED BY: profile agent.
//
// The Profile HUB — the app's only secondary page, reached via the profile icon in
// the lobby header and dismissed with the back arrow. It MERGES what used to be the
// separate Wallet + Rank tabs (the app has no tab bar): identity + lifetime stats,
// a wallet section (on-chain wallet in real mode, add/cash-out in play mode), your
// rank + the global leaderboard, the unified history, and settings. All state flows
// through the store (@/state). Web-safe — reuses @/ui + feature components.
import React, { useCallback, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
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
import { useChain } from "@/features/chain/useChain";
import { useProfileChainClaims } from "@/features/chain/useProfileChainClaims";
import { ChainWalletHero } from "@/features/wallet";
import { useWalletFund } from "@/features/wallet/useWalletFund";
import { PointsLeaderboard } from "@/features/points/PointsLeaderboard";
import { usePointsLeaderboardSync } from "@/features/points/usePointsLeaderboardSync";
import { usePointsIdentity } from "@/features/points/usePointsIdentity";
import { pts } from "@/lib/format";
import { AccountCard } from "@/features/auth/AccountCard";
import { useAccount } from "@/features/auth/useAccount";
import type { LedgerRail } from "@/state/types";
import { ReferralPanel } from "@/features/referrals/ReferralPanel";

const FILTERS: { value: LedgerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "bets", label: "Bets" },
  { value: "cash", label: "Cash" },
];

export default function ProfileHub() {
  const router = useRouter();
  const account = useAccount();
  const store = useStore();
  const hx = store.session.hapticsOn;

  const bal = useDisplayBalance(); // real USX in chain mode, paper points or sandbox cash otherwise
  const activeRail: LedgerRail = bal.points ? "points" : bal.chain ? "usx" : "cash";
  const scopedBets = useMemo(
    () => store.bets.filter((b) => (b.rail ?? "cash") === activeRail),
    [store.bets, activeRail],
  );
  const stats = useMemo(() => lifetimeStats(scopedBets), [scopedBets]);

  // Wallet (real-mode on-chain wallet + faucet/withdraw flow).
  const chain = useChain();
  const {
    realWallet,
    fund,
    funding,
    faucetEnabled,
    faucetWaitSec,
    canFund,
  } = useWalletFund();
  const { ready: chainReady, refreshBalance } = chain;
  const realMoney = store.session.moneyMode === "real";
  const profileClaims = useProfileChainClaims(chain, realMoney && chainReady);
  useFocusEffect(
    React.useCallback(() => {
      if (chainReady) void refreshBalance();
    }, [chainReady, refreshBalance]),
  );

  // Rank (the one global points leaderboard).
  const { userId: meId } = usePointsIdentity();
  usePointsLeaderboardSync(true);

  const [filter, setFilter] = useState<LedgerFilter>("all");
  const scopedHistory = useMemo(
    () => store.history.filter((item) => (item.rail ?? "cash") === activeRail),
    [store.history, activeRail],
  );
  const ledger = useMemo(
    () => filterLedger(scopedHistory, filter),
    [scopedHistory, filter],
  );
  const HISTORY_CAP = 5;
  const visibleLedger = useMemo(() => ledger.slice(0, HISTORY_CAP), [ledger]);

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

  const goLive = store.session.mode === "live";
  const feedOps = useFeedOps(goLive);

  const loadDemo = useCallback(() => {
    store.setMode("offline");
    if (hx) haptics.tap();
    router.push("/match/sim-arg-fra");
  }, [store, hx, router]);

  const openDeposit = useCallback(() => router.push("/(modals)/deposit"), [router]);
  const openWithdraw = useCallback(() => router.push("/(modals)/withdraw"), [router]);

  // Back to the lobby (the one primary page). Falls back to a hard replace if the
  // stack can't pop (e.g. deep-linked straight into Profile).
  const goBack = useCallback(() => {
    if (hx) haptics.tap();
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router, hx]);

  // Signed-out (web, Privy on): show ONLY the sign-in card. AFTER every hook above.
  const needsSignIn = account.enabled && account.ready && !account.authenticated;
  if (needsSignIn) {
    return (
      <Screen vignette="gold">
        <UnifiedHeader variant="slim" title="Profile" onBack={goBack} />
        <AccountCard noTopMargin />
      </Screen>
    );
  }

  return (
    <Screen vignette="gold">
      <UnifiedHeader variant="slim" title="Profile" onBack={goBack} />

      <ProfileHero
        name={store.session.displayName ?? ""}
        balance={bal.amount}
        balanceFormat={bal.format}
        balanceLabel={bal.points ? "Points" : bal.chain ? "USX balance" : "Balance"}
        signedFormat={bal.signedFormat}
        stats={stats}
        onEditName={openEdit}
      />

      {/* Account — Privy sign-in (recoverable, cross-device wallet) */}
      <AccountCard />

      <View style={styles.section}>
        <ReferralPanel />
      </View>

      {/* Wallet — on-chain wallet in real mode; add / cash-out in play mode. */}
      <View style={styles.section}>
        <Text preset="subtitle" style={styles.sectionTitle}>
          Wallet
        </Text>
        {realWallet ? (
          <ChainWalletHero
            address={chain.address}
            balanceUsd={chain.balanceUsd}
            airdropEnabled={faucetEnabled}
            onFund={fund}
            onWithdraw={openWithdraw}
            funding={funding}
            fundDisabled={!canFund}
            fundWaitSec={faucetWaitSec}
          />
        ) : (
          <View style={styles.walletActions}>
            <Button
              label="Add cash"
              onPress={openDeposit}
              variant="secondary"
              fullWidth
              style={styles.walletBtn}
            />
            <Button
              label="Cash out"
              onPress={openWithdraw}
              variant="ghost"
              fullWidth
              style={styles.walletBtn}
              disabled={bal.amount <= 0}
            />
          </View>
        )}
        {realWallet && profileClaims.claimableCount > 0 ? (
          <View style={styles.claimAllWrap}>
            <Button
              label={
                profileClaims.claiming
                  ? `Claiming ${profileClaims.claimableCount}…`
                  : `Claim ${profileClaims.claimableCount} pending payout${profileClaims.claimableCount === 1 ? "" : "s"}`
              }
              onPress={() => void profileClaims.claimAll()}
              variant="primary"
              fullWidth
              disabled={profileClaims.claiming}
              glow
            />
            {profileClaims.error ? (
              <Text preset="caption" style={styles.claimError}>
                {profileClaims.error}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Rank — your standing + the one global leaderboard. */}
      <View style={styles.section}>
        <Text preset="subtitle" style={styles.sectionTitle}>
          Rank
        </Text>
        <View style={styles.standing}>
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>RANK</Text>
            <Text style={styles.statValue}>#{store.pointsRank || "—"}</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>POINTS</Text>
            <Text style={styles.statValue}>{pts(store.pointsBalance)}</Text>
          </View>
          {store.pointsRank === 1 ? (
            <View style={styles.laneChip}>
              <Text style={styles.laneChipText}>LEADING</Text>
            </View>
          ) : null}
        </View>
        <PointsLeaderboard
          players={store.pointsLeaderboard}
          meId={meId}
          compact
        />
      </View>

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
            onPress={loadDemo}
            hapticsEnabled={hx}
          />
          <LinkRow
            glyph=""
            title="How GOLAZO works"
            sub="Market flow and settlement"
            onPress={() => router.push("/how-it-works")}
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
          <Button label="Save" onPress={saveName} variant="primary" fullWidth glow />
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
  sectionTitle: { marginBottom: spacing.md },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  historyTitle: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexShrink: 1,
    gap: spacing.xs,
  },
  // Wallet (play mode) — a clean two-button action row.
  walletActions: { flexDirection: "row", gap: spacing.md },
  walletBtn: { flex: 1 },
  claimAllWrap: { marginTop: spacing.md, gap: spacing.xs },
  claimError: { color: colors.no, textAlign: "center" },
  // Rank — flat "your standing" card: stat cells + an optional LEADING lane chip.
  standing: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xl,
    marginBottom: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  statCell: { gap: 2 },
  statLabel: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.4,
  },
  statValue: { ...type.display, fontSize: 22, color: colors.textPrimary },
  laneChip: {
    marginLeft: "auto",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.alpha.yes,
  },
  laneChipText: {
    ...type.overline,
    fontSize: 10,
    color: colors.yes,
    letterSpacing: 1.2,
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
