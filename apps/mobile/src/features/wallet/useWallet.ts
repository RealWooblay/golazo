import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import type { DepositMethod, WithdrawDestination } from "@/state/types";
import { haptics, hapticIf } from "@/ui/haptics";
import { getRamp, type RampAdapter } from "./ramp";
import { openExternal } from "./platform";

/**
 * useWallet — the wallet feature's brain. Wraps the global store's money actions
 * with the on/off-ramp flows so the screens stay declarative.
 *
 * It owns one piece of *local* state: `flow`, the status of an in-flight ramp
 * (idle → pending → success | error). Screens render their pending/success
 * animations off this. The durable money mutation always goes through the store
 * (`deposit`/`withdraw`), which appends the ledger row atomically.
 *
 * Sandbox vs live:
 *   • Sandbox (no provider keys): `runOnramp`/`runOfframp` simulate a short
 *     pending window then credit/debit the store and resolve `success`.
 *   • Live: we open the provider widget in a browser, optimistically mark the
 *     intent, and (for the deposit path) credit on the provider redirect. Since
 *     this build has no backend webhook, the live path still records the intent
 *     and the screen shows "complete in the provider window" guidance.
 */

export type FlowKind = "deposit" | "withdraw";
export type FlowStatus = "idle" | "pending" | "success" | "error";

export interface FlowState {
  kind: FlowKind | null;
  status: FlowStatus;
  amount: number;
  message?: string;
}

const SANDBOX_SETTLE_MS = 1400; // tasteful pending beat before success

export interface UseWallet {
  balance: number;
  ramp: RampAdapter;
  isLive: boolean;
  flow: FlowState;
  /** Reset the flow back to idle (call when a sheet closes / on "done"). */
  resetFlow: () => void;
  /** On-ramp. method 'sandbox' forces the simulated path regardless of keys. */
  runOnramp: (args: {
    amount: number;
    method: DepositMethod;
    walletAddress: string;
    hapticsOn?: boolean;
  }) => Promise<void>;
  /** Crypto deposit auto-credit (sandbox demo of an incoming transfer). */
  simulateIncomingDeposit: (
    amount: number,
    hapticsOn?: boolean,
  ) => Promise<void>;
  /** Off-ramp / cash out. */
  runOfframp: (args: {
    amount: number;
    destination: WithdrawDestination;
    walletAddress: string;
    hapticsOn?: boolean;
  }) => Promise<void>;
}

export function useWallet(): UseWallet {
  const store = useStore();
  const ramp = useMemo(() => getRamp(), []);
  const [flow, setFlow] = useState<FlowState>({
    kind: null,
    status: "idle",
    amount: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetFlow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setFlow({ kind: null, status: "idle", amount: 0 });
  }, []);

  const settleAfter = useCallback((fn: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, SANDBOX_SETTLE_MS);
  }, []);

  // ── ON-RAMP ─────────────────────────────────────────────────────────────────
  const runOnramp = useCallback<UseWallet["runOnramp"]>(
    async ({ amount, method, walletAddress, hapticsOn }) => {
      if (!(amount > 0)) {
        setFlow({
          kind: "deposit",
          status: "error",
          amount,
          message: "Enter an amount first.",
        });
        hapticIf(hapticsOn, "error");
        return;
      }

      setFlow({ kind: "deposit", status: "pending", amount });

      const useSandbox = !ramp.isLive || method === "sandbox";

      if (useSandbox) {
        settleAfter(() => {
          store.deposit({ amount, method });
          setFlow({ kind: "deposit", status: "success", amount });
          hapticIf(hapticsOn, "win");
        });
        return;
      }

      // LIVE: open the provider widget. Settlement is confirmed by the provider
      // redirect / backend webhook (services/). With no backend in this build we
      // record the intent and guide the user to finish in the provider window.
      try {
        const built = await ramp.buildBuyUrl({
          fiatAmount: amount,
          fiatCurrency: ramp.fiatCurrency,
          cryptoCurrency: ramp.cryptoCurrency,
          walletAddress,
          preferredMethod: method === "apple_pay" ? "apple_pay" : "card",
        });
        const opened = await openExternal(built.url);
        if (!opened) throw new Error("Could not open the payment window.");
        setFlow({
          kind: "deposit",
          status: "success",
          amount,
          message:
            "Finish in the secure payment window — your balance updates on confirmation.",
        });
        hapticIf(hapticsOn, "select");
      } catch (e) {
        setFlow({
          kind: "deposit",
          status: "error",
          amount,
          message: e instanceof Error ? e.message : "Something went wrong.",
        });
        hapticIf(hapticsOn, "error");
      }
    },
    [ramp, settleAfter, store],
  );

  // ── Crypto deposit auto-credit (sandbox) ─────────────────────────────────────
  const simulateIncomingDeposit = useCallback<
    UseWallet["simulateIncomingDeposit"]
  >(
    async (amount, hapticsOn) => {
      if (!(amount > 0)) return;
      store.deposit({ amount, method: "crypto" });
      hapticIf(hapticsOn, "win");
    },
    [store],
  );

  // ── OFF-RAMP ──────────────────────────────────────────────────────────────────
  const runOfframp = useCallback<UseWallet["runOfframp"]>(
    async ({ amount, destination, walletAddress, hapticsOn }) => {
      if (!(amount > 0)) {
        setFlow({
          kind: "withdraw",
          status: "error",
          amount,
          message: "Enter an amount first.",
        });
        hapticIf(hapticsOn, "error");
        return;
      }
      if (amount > store.balance) {
        setFlow({
          kind: "withdraw",
          status: "error",
          amount,
          message: "That's more than your balance.",
        });
        hapticIf(hapticsOn, "error");
        return;
      }

      setFlow({ kind: "withdraw", status: "pending", amount });

      const useSandbox = !ramp.isLive || destination !== "bank";

      if (useSandbox) {
        // Crypto + sandbox payouts settle locally (play money).
        settleAfter(() => {
          store.withdraw({ amount, destination });
          setFlow({ kind: "withdraw", status: "success", amount });
          hapticIf(hapticsOn, "win");
        });
        return;
      }

      // LIVE cash-out to card/bank → open the provider sell widget.
      try {
        const built = await ramp.buildSellUrl({
          fiatCurrency: ramp.fiatCurrency,
          cryptoCurrency: ramp.cryptoCurrency,
          cryptoAmount: amount, // UI passes a crypto-denominated amount for live
          walletAddress,
        });
        const opened = await openExternal(built.url);
        if (!opened) throw new Error("Could not open the cash-out window.");
        // Debit optimistically; a real build reconciles via webhook.
        store.withdraw({ amount, destination });
        setFlow({
          kind: "withdraw",
          status: "success",
          amount,
          message: "Finish the cash-out in the secure window.",
        });
        haptics.select();
      } catch (e) {
        setFlow({
          kind: "withdraw",
          status: "error",
          amount,
          message: e instanceof Error ? e.message : "Something went wrong.",
        });
        hapticIf(hapticsOn, "error");
      }
    },
    [ramp, settleAfter, store],
  );

  return {
    balance: store.balance,
    ramp,
    isLive: ramp.isLive,
    flow,
    resetFlow,
    runOnramp,
    simulateIncomingDeposit,
    runOfframp,
  };
}
