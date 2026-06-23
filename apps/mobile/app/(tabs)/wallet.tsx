// OWNED BY: wallet agent.
import React from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { Screen, Toast } from "@/ui";
import { spacing } from "@/theme";
import {
  ActivityList,
  ChainWalletHero,
  SectionHeader,
  WalletHero,
} from "@/features/wallet";
import { useWalletFund } from "@/features/wallet/useWalletFund";
import { useChain } from "@/features/chain/useChain";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { AccountCard } from "@/features/auth/AccountCard";
import { useAccount } from "@/features/auth/useAccount";

export default function WalletTab() {
  const router = useRouter();
  const account = useAccount();
  const { balance, transactions } = useStore();
  const chain = useChain();
  const {
    realWallet,
    fund,
    funding,
    fundMsg,
    clearFundMsg,
    faucetEnabled,
    faucetWaitSec,
    canFund,
  } = useWalletFund();

  const { ready: chainReady, refreshBalance } = chain;
  useFocusEffect(
    React.useCallback(() => {
      if (chainReady) void refreshBalance();
    }, [chainReady, refreshBalance]),
  );

  const openDeposit = () => router.push("/(modals)/deposit");
  const openWithdraw = () => router.push("/(modals)/withdraw");

  const needsSignIn =
    account.enabled && account.ready && !account.authenticated;

  if (needsSignIn) {
    return (
      <Screen vignette="yes">
        <UnifiedHeader variant="screen" title="Wallet" />
        <AccountCard noTopMargin />
      </Screen>
    );
  }

  return (
    <Screen vignette="yes">
      <UnifiedHeader variant="screen" title="Wallet" />

      {realWallet ? (
        <ChainWalletHero
          address={chain.address}
          balanceUsd={chain.balanceUsd}
          balanceSol={chain.balanceSol}
          airdropEnabled={faucetEnabled}
          onFund={fund}
          onWithdraw={openWithdraw}
          funding={funding}
          fundDisabled={!canFund}
          fundWaitSec={faucetWaitSec}
        />
      ) : (
        <WalletHero
          balance={balance}
          flair="Play money · practice freely"
          onAddCash={openDeposit}
          onCashOut={openWithdraw}
          cashOutDisabled={balance <= 0}
        />
      )}

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

      <Toast message={fundMsg} tone="info" onHide={clearFundMsg} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.xxl, gap: spacing.md },
});
