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
import React, { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import type { DepositMethod } from "@/state/types";
import { Screen, Text, Button, Toast } from "@/ui";
import { colors, spacing, type } from "@/theme";
import {
  AmountInput,
  DepositAddressCard,
  FlowStatus,
  MethodHeaderTabs,
  MethodOption,
  ModalHeader,
  useDepositAddress,
  useWallet,
} from "@/features/wallet";

type Tab = "cash" | "crypto";

export default function DepositModal() {
  const router = useRouter();
  const { session } = useStore();
  const wallet = useWallet();
  const address = useDepositAddress();

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
        <ModalHeader
          chip="Add cash"
          chipTone="info"
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
      <ModalHeader
        chip="Add cash"
        chipTone="info"
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
});
