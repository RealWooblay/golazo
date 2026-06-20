import React, { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "@/state/store";
import { useChain } from "@/features/chain/useChain";

const FAUCET_COOLDOWN_MS = 45_000;
const FAUCET_KEY = "golazo:faucet:lastAt";

/** Client-side throttle so devnet faucet spam doesn't brick the button. */
export function useFaucetCooldown() {
  const [readyAt, setReadyAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    AsyncStorage.getItem(FAUCET_KEY)
      .then((raw) => setReadyAt(raw ? Number(raw) + FAUCET_COOLDOWN_MS : 0))
      .catch(() => {});
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const markUsed = useCallback(() => {
    const t = Date.now();
    setReadyAt(t + FAUCET_COOLDOWN_MS);
    AsyncStorage.setItem(FAUCET_KEY, String(t)).catch(() => {});
  }, []);

  const waitSec = Math.max(0, Math.ceil((readyAt - now) / 1000));
  return { canFund: waitSec <= 0, waitSec, markUsed };
}

export function useWalletFund() {
  const chain = useChain();
  const { mode } = useStore();
  const cooldown = useFaucetCooldown();
  const [funding, setFunding] = useState(false);
  const [fundMsg, setFundMsg] = useState<string | null>(null);

  const fund = useCallback(async () => {
    if (!chain.ready || funding || !cooldown.canFund) return;
    setFunding(true);
    setFundMsg("Requesting test SOL…");
    cooldown.markUsed();
    try {
      await chain.airdrop(1);
      await chain.refreshBalance();
      setFundMsg("Funded ✓ — 1 test SOL added");
    } catch {
      setFundMsg(
        chain.cluster === "localnet"
          ? "No validator on localnet — needs devnet."
          : "Faucet busy — wait a minute and try again.",
      );
    } finally {
      setFunding(false);
    }
  }, [chain, funding, cooldown]);

  const realWallet = chain.ready && mode === "live";

  return {
    realWallet,
    fund,
    funding,
    fundMsg,
    clearFundMsg: () => setFundMsg(null),
    faucetEnabled: chain.airdropEnabled,
    faucetWaitSec: cooldown.waitSec,
    canFund: cooldown.canFund,
  };
}
