// OWNED BY: wallet agent (deposit / on-ramp flow).
//
// Presented modally. The funding paths shown adapt to what's actually possible:
// • Add cash (card / Apple Pay) — fiat on-ramp via the swappable ramp adapter.
// ONLY shown when a real provider key is configured (ramp.isLive). With no
// provider the hosted widget can't open, so these methods are hidden entirely
// rather than offered-then-failed.
// • Deposit crypto — shows the user's Solana address + a Solana Pay QR. In
// sandbox (the no-provider default) this is the sole path, and we offer a
// one-tap "simulate incoming" to demo the auto-credit.
//
// Web-safe: no chain/native lib at module load (address comes via the store
// contract; ramp/browser/clipboard shims lazy-require behind fallbacks).
import React, { useCallback, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import type { DepositMethod } from "@/state/types";
import { Screen, Text, Button, Toast } from "@/ui";
import { colors, spacing, type } from "@/theme";
import { money } from "@/lib/format";
import {
  AmountInput,
  DepositAddressCard,
  FlowStatus,
  MethodHeaderTabs,
  MethodOption,
  useDepositAddress,
  useWallet,
} from "@/features/wallet";
import { usePrivyOnramp } from "@/features/wallet/usePrivyOnramp";
import { useChain } from "@/features/chain/useChain";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";

type Tab = "cash" | "crypto";

export default function DepositModal() {
  const router = useRouter();
  const { session } = useStore();
  const wallet = useWallet();
  const address = useDepositAddress();
  const chain = useChain();
  const onramp = usePrivyOnramp();

  // REAL on-chain mode (web + signed in): the genuine USX deposit flow — card
  // on-ramp + one-tap auto-swap to USX. Takes over the whole modal; the
  // play-money paths below are for sandbox/demo only.
  if (chain.ready) {
    return <RealChainDeposit chain={chain} onramp={onramp} onClose={() => router.back()} />;
  }

  // Card / Apple Pay on-ramp is only a real, completable option when a fiat
  // provider key is configured (ramp.isLive). With no provider (sandbox), the
  // card/Apple Pay widget can't open — so we DON'T show those methods at all and
  // fall straight to the crypto-receive / simulate path that actually works.
  const showCash = wallet.isLive;

  const [tab, setTab] = useState<Tab>(showCash ? "cash" : "crypto");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DepositMethod>("card");
  const [toast, setToast] = useState<string | null>(null);

  const numeric = Number(amount || 0);
  const inFlow =
    wallet.flow.kind === "deposit" && wallet.flow.status !== "idle";
  const hapticsOn = session.hapticsOn;

  const close = () => {
    wallet.resetFlow();
    router.back();
  };

  const submit = () => {
    void wallet.runOnramp({
      amount: numeric,
      method,
      walletAddress: address.address,
      hapticsOn,
    });
  };

  // ── Flow status takes over the whole modal once a card deposit is in flight ──
  if (inFlow) {
    return (
      <Screen scroll={false} topInset>
        <UnifiedHeader
          variant="modal"
          chip={{ label: "Add cash", tone: "info" }}
          title="Deposit"
          onClose={close}
        />
        <FlowStatus
          kind="deposit"
          status={wallet.flow.status}
          amount={wallet.flow.amount}
          message={wallet.flow.message}
          onDone={close}
          onRetry={() => {
            wallet.resetFlow();
            submit();
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen topInset footerSpace={spacing.xl}>
      <UnifiedHeader
        variant="modal"
        chip={{ label: "Add cash", tone: "info" }}
        title="Deposit"
        onClose={close}
      />

      {/* Only offer the method switcher when card/Apple Pay is actually
          available. In sandbox (no provider) there's a single path — crypto
          receive / simulate — so we skip the tabs entirely. */}
      {showCash ? (
        <MethodHeaderTabs
          tabs={[
            { id: "cash", label: "Card / Apple Pay" },
            { id: "crypto", label: "Crypto" },
          ]}
          active={tab}
          onChange={(t) => setTab(t as Tab)}
        />
      ) : null}

      {showCash && tab === "cash" ? (
        <CashPath
          amount={amount}
          onAmount={setAmount}
          method={method}
          onMethod={setMethod}
          isLive={wallet.isLive}
        />
      ) : (
        <CryptoPath
          address={address.address}
          live={address.live}
          onSimulate={() => {
            void wallet.simulateIncomingDeposit(100, hapticsOn);
            setToast("Received $100 · balance updated");
          }}
        />
      )}

      {showCash && tab === "cash" ? (
        <View style={styles.footer}>
          <Button
            label={
              numeric > 0 ? `Add ${moneyLabel(numeric)}` : "Enter an amount"
            }
            onPress={submit}
            variant="primary"
            size="lg"
            fullWidth
            glow
            disabled={numeric <= 0}
          />
          <Text style={[type.caption, styles.legal]}>
            {wallet.isLive
              ? "Powered by a secure payment provider. You leave the app to complete payment."
              : "Demo mode — no real charge. Credits your play balance instantly."}
          </Text>
        </View>
      ) : null}

      <Toast message={toast} tone="success" onHide={() => setToast(null)} />
    </Screen>
  );
}

// ── REAL on-chain USX deposit: card on-ramp + one-tap auto-swap to USX ─────────
type RealStatus = "idle" | "buying" | "waiting" | "converting" | "done" | "error";

function RealChainDeposit({
  chain,
  onramp,
  onClose,
}: {
  chain: ReturnType<typeof useChain>;
  onramp: ReturnType<typeof usePrivyOnramp>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<RealStatus>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const busy = status === "buying" || status === "waiting" || status === "converting";

  const convert = useCallback(async () => {
    setStatus("converting");
    setMsg(null);
    try {
      const { swapped, failures } = await chain.convertToUsx();
      if (swapped.length === 0) {
        setStatus("error");
        setMsg(failures[0]?.reason ?? "Nothing to convert yet — fund the wallet first.");
        return;
      }
      const usd = swapped.reduce((s, r) => s + r.outUsd, 0);
      const skipped = failures.length
        ? ` (${failures.length} asset${failures.length > 1 ? "s" : ""} skipped)`
        : "";
      setStatus("done");
      setMsg(`Converted to ${money(usd)} USX${skipped}.`);
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Couldn't convert to USX.");
    }
  }, [chain]);

  const buy = useCallback(async (method: "card" | "stripe") => {
    if (!onramp.supported || !chain.address) return;
    setStatus("buying");
    setMsg(null);
    try {
      await onramp.open({
        address: chain.address,
        method,
        onExit: () => {
          // The card payout settles seconds-to-minutes AFTER the widget closes —
          // wait, then auto-swap whatever landed into USX.
          setStatus("waiting");
          setMsg("Waiting for your deposit to arrive, then converting to USX…");
          setTimeout(() => {
            void convert();
          }, 8000);
        },
      });
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Couldn't open card funding.");
    }
  }, [onramp, chain.address, convert]);

  return (
    <Screen topInset footerSpace={spacing.xl}>
      <UnifiedHeader
        variant="modal"
        chip={{ label: "Add USX", tone: "info" }}
        title="Deposit"
        onClose={onClose}
      />
      <View style={styles.path}>
        <Text style={[type.body, styles.cryptoIntro]}>
          Add funds any way you like — we convert it to USX automatically.
        </Text>

        {onramp.supported ? (
          <Button
            label="Buy with card"
            onPress={() => buy("card")}
            variant="primary"
            size="lg"
            fullWidth
            glow
            loading={status === "buying"}
            disabled={busy}
          />
        ) : null}

        {onramp.supported && onramp.stripeSupported ? (
          <Button
            label="Pay with Stripe"
            onPress={() => buy("stripe")}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={busy}
          />
        ) : null}

        <DepositAddressCard address={chain.address ?? "—"} live network="Solana" />
        <Text style={[type.caption, styles.simulateHint]}>
          Or send SOL / USDC to that address. Keep a little SOL for network fees.
        </Text>

        <Button
          label="Convert wallet to USX"
          onPress={convert}
          variant={onramp.supported ? "secondary" : "primary"}
          size="lg"
          fullWidth
          loading={status === "converting" || status === "waiting"}
          disabled={busy}
        />

        {msg ? (
          <Text style={[type.caption, status === "error" ? styles.errMsg : styles.okMsg]}>
            {msg}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

// ── Card / Apple Pay sub-flow ─────────────────────────────────────────────────
function CashPath({
  amount,
  onAmount,
  method,
  onMethod,
  isLive,
}: {
  amount: string;
  onAmount: (v: string) => void;
  method: DepositMethod;
  onMethod: (m: DepositMethod) => void;
  isLive: boolean;
}) {
  const showApplePay = Platform.OS === "ios";
  const demoTag = isLive ? undefined : "Demo";

  return (
    <View style={styles.path}>
      <AmountInput
        value={amount}
        onChange={onAmount}
        presets={[25, 50, 100, 250]}
        caption="How much do you want to add?"
        autoFocus
      />

      <View style={styles.methods}>
        <Text style={[type.overline, styles.methodsLabel]}>Pay with</Text>
        <MethodOption
          icon=""
          title="Debit or credit card"
          subtitle="Visa · Mastercard · instant"
          tag={demoTag ?? "Instant"}
          tint="cyan"
          selected={method === "card"}
          onPress={() => onMethod("card")}
        />
        {showApplePay ? (
          <MethodOption
            icon=""
            title="Apple Pay"
            subtitle="One-tap checkout"
            tag={demoTag ?? "Fast"}
            tint="yes"
            selected={method === "apple_pay"}
            onPress={() => onMethod("apple_pay")}
          />
        ) : null}
      </View>
    </View>
  );
}

// ── Crypto deposit sub-flow ───────────────────────────────────────────────────
function CryptoPath({
  address,
  live,
  onSimulate,
}: {
  address: string;
  live: boolean;
  onSimulate: () => void;
}) {
  return (
    <View style={styles.path}>
      <Text style={[type.body, styles.cryptoIntro]}>
        Scan with any Solana wallet, or copy your address to send funds.
      </Text>
      <DepositAddressCard address={address} live={live} network="Solana" />

      {!live ? (
        <View style={styles.simulate}>
          {/* High-contrast primary CTA (lime gradient, dark text) — the sandbox
              "add cash" action. Previously a faint cyan-on-dark pressable that
              read as nearly invisible. */}
          <Button
            label="Simulate an incoming $100"
            onPress={onSimulate}
            variant="primary"
            size="lg"
            fullWidth
            glow
          />
          <Text style={[type.caption, styles.simulateHint]}>
            Demo the auto-credit without a real transfer
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function moneyLabel(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

const styles = StyleSheet.create({
  path: { gap: spacing.xl, marginTop: spacing.xl },
  methods: { gap: spacing.sm },
  methodsLabel: { color: colors.textMuted, marginBottom: spacing.xs },
  footer: { marginTop: spacing.xl, gap: spacing.sm },
  legal: { color: colors.textFaint, textAlign: "center" },
  cryptoIntro: {
    color: colors.textMuted,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },
  simulate: {
    alignItems: "center",
    gap: spacing.sm,
  },
  simulateHint: { color: colors.textFaint, textAlign: "center" },
  okMsg: { color: colors.yes, textAlign: "center" },
  errMsg: { color: colors.no, textAlign: "center" },
});
