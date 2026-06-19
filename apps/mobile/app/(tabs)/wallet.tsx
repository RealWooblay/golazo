// OWNED BY: wallet agent.
//
// The Wallet tab — a premium, normie-friendly home for money. A glowing balance
// hero (animated count) with Add cash / Cash out CTAs, a streak/promo flair, and
// the recent-activity ledger from the store. Pure play-money + web-safe: no chain
// or native lib is imported at module load (the deposit-address resolver reads the
// store contract; ramp shims lazy-require behind fallbacks).
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { Chip, Screen, Toast } from "@/ui";
import { spacing } from "@/theme";
import {
  ActivityList,
  ChainWalletHero,
  SectionHeader,
  WalletHero,
} from "@/features/wallet";
import { ScreenHeader } from "@/features/_shared/ScreenHeader";
import { useChain } from "@/features/chain/useChain";

export default function WalletTab() {
  const router = useRouter();
  const { balance, transactions, mode } = useStore();
  const chain = useChain();
  const [funding, setFunding] = useState(false);
  const [fundMsg, setFundMsg] = useState<string | null>(null);
  // Real wallet only in live mode; a demo game keeps the play-money wallet.
  const realWallet = chain.ready && mode === "live";

  // Pull a fresh on-chain balance whenever the tab comes into focus. The wallet
  // can be funded externally (SOL sent to the deposit address) with no in-app
  // action to trigger a read, so without this the hero can sit at a stale $0.
  // `refreshBalance` is stable (and a no-op until ready), so this can't loop.
  const { ready: chainReady, refreshBalance } = chain;
  useFocusEffect(
    React.useCallback(() => {
      if (chainReady) void refreshBalance();
    }, [chainReady, refreshBalance]),
  );

  const openDeposit = () => router.push("/(modals)/deposit");
  const openWithdraw = () => router.push("/(modals)/withdraw");

  const fund = async () => {
    if (!chain.ready) return;
    setFunding(true);
    setFundMsg("Requesting test SOL…");
    try {
      await chain.airdrop(2);
      await chain.refreshBalance();
      setFundMsg("Funded ✓ — balance updating");
    } catch {
      // The most common cause is the cluster: on localnet there's no validator;
      // on devnet the public faucet is rate-limited.
      setFundMsg(
        chain.cluster === "localnet"
          ? "No validator on localnet — this build needs devnet."
          : "Faucet didn't respond (devnet is rate-limited) — try again shortly.",
      );
    } finally {
      setFunding(false);
    }
  };

  return (
    <Screen vignette="yes">
      <ScreenHeader
        title="Wallet"
        accessory={
          <Chip
            label={realWallet ? "ON-CHAIN" : "SANDBOX"}
            tone={realWallet ? "live" : "neutral"}
            dot={realWallet}
          />
        }
      />

      {realWallet ? (
        // LIVE / on-chain mode → the REAL embedded wallet (actual SOL).
        <ChainWalletHero
          address={chain.address}
          balanceSol={chain.balanceSol}
          cluster={chain.cluster}
          airdropEnabled={chain.airdropEnabled}
          onFund={fund}
          onWithdraw={openWithdraw}
          funding={funding}
        />
      ) : (
        // Sandbox mode → play-money practice balance.
        <WalletHero
          balance={balance}
          flair="Play money · practice freely"
          onAddCash={openDeposit}
          onCashOut={openWithdraw}
          cashOutDisabled={balance <= 0}
        />
      )}

      {/* The play-money activity ledger only applies in demo/sandbox mode. */}
      {!realWallet ? (
        <View style={styles.section}>
          <SectionHeader
            title="Activity"
            actionLabel="How it works"
            onAction={() => router.push("/how-it-works")}
          />
          <ActivityList rows={transactions} limit={8} onAddCash={openDeposit} />
        </View>
      ) : null}

      <Toast message={fundMsg} tone="info" onHide={() => setFundMsg(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.xxl, gap: spacing.md },
});
