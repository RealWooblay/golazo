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
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import type { DepositMethod } from "@/state/types";
import { Screen, Text, Button, Toast } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
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
        </View>
      ) : null}

      <Toast message={toast} tone="success" onHide={() => setToast(null)} />
    </Screen>
  );
}

// ── REAL on-chain USX deposit: card on-ramp + one-tap auto-swap to USX ─────────
type RealStatus = "idle" | "buying" | "waiting" | "converting" | "done" | "error";

/**
 * Deposit trust checklist — minimal on-chain proof link only.
 */
function TrustChecklist({ address, done }: { address?: string; done?: boolean }) {
  const explorer = address ? `https://solscan.io/account/${address}` : undefined;
  if (!explorer) return null;
  return (
    <Text
      style={styles.trustProof}
      onPress={() => Linking.openURL(explorer).catch(() => {})}
    >
      {done ? "View on Solscan ↗" : "Verify wallet on Solscan ↗"}
    </Text>
  );
}


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

  // Latest chain handle for the interval closure (avoids stale captures).
  const chainRef = useRef(chain);
  chainRef.current = chain;
  // armed → a deposit is expected (on-ramp purchased OR balance grew) → convert it.
  const armedRef = useRef(false);
  const doneRef = useRef(false);
  const convertingRef = useRef(false);
  const baseSolRef = useRef<number | null>(null);
  /** USDC balance snapshot at card-purchase start — card payouts are USDC (SOL won't move). */
  const usdcBaselineRef = useRef<number | null>(null);

  const usdcAmount = (candidates: Awaited<ReturnType<typeof chain.peekSwappable>>) =>
    candidates.find((c) => c.label === "USDC")?.amount ?? 0;

  // Auto-swap whatever non-USX landed → USX. Returns silently while nothing has
  // arrived yet (swapAllToUsx no longer throws on empty), so the poll can keep
  // waiting; only a real swap failure surfaces an error.
  const autoConvert = useCallback(async (opts: { manual?: boolean } = {}) => {
    if (convertingRef.current || doneRef.current) return;
    const available = await chainRef.current.peekSwappable().catch(() => []);
    if (available.length === 0) {
      if (opts.manual) {
        setStatus("idle");
        setMsg("No SOL or USDC detected yet.");
      } else {
        setStatus("waiting");
        setMsg("Waiting for funds…");
      }
      return;
    }
    convertingRef.current = true;
    setStatus("converting");
    setMsg("Converting…");
    try {
      const { swapped, failures } = await chainRef.current.convertToUsx();
      if (swapped.length > 0) {
        doneRef.current = true;
        armedRef.current = false;
        usdcBaselineRef.current = null;
        const usd = swapped.reduce((s, r) => s + r.outUsd, 0);
        setStatus("done");
        setMsg(`Added ${money(usd)} USX`);
      } else if (failures.length > 0) {
        setStatus("error");
        setMsg(failures[0].reason);
      } else {
        // Nothing has landed yet — stay armed and keep waiting for the deposit.
        setStatus("waiting");
        setMsg("Waiting for funds…");
      }
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Couldn't convert to USX.");
    } finally {
      convertingRef.current = false;
    }
  }, []);

  // Poll while waiting: detect USDC (card) or SOL (crypto) deposits → auto-convert.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || doneRef.current) return;
      const [info, candidates] = await Promise.all([
        chainRef.current.refreshBalance().catch(() => null),
        chainRef.current.peekSwappable().catch(() => []),
      ]);
      const sol = info?.balanceSol;
      if (typeof sol === "number") {
        if (baseSolRef.current === null) baseSolRef.current = sol;
        else if (sol > baseSolRef.current + 0.0005) armedRef.current = true;
        if (sol > (baseSolRef.current ?? 0)) baseSolRef.current = sol;
      }
      const usdc = usdcAmount(candidates);
      if (usdcBaselineRef.current !== null && usdc > usdcBaselineRef.current) {
        armedRef.current = true;
      }
      if (armedRef.current && candidates.length > 0 && !convertingRef.current) await autoConvert();
      else if (armedRef.current && status !== "waiting") {
        setStatus("waiting");
        setMsg("Waiting for funds…");
      }
    };
    const ms = status === "waiting" || status === "converting" ? 3000 : 6000;
    const id = setInterval(() => void tick(), ms);
    void tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [autoConvert, status]);

  const buy = useCallback(
    async (method: "card" | "stripe") => {
      const c = chainRef.current;
      if (!onramp.supported || !c.address) return;
      setStatus("buying");
      setMsg(null);
      try {
        const before = await c.peekSwappable().catch(() => []);
        usdcBaselineRef.current = usdcAmount(before);
        await onramp.open({
          address: c.address,
          method,
          // Payout settles async — arm watcher; USDC increase also arms via poll.
          onExit: () => {
            armedRef.current = true;
            doneRef.current = false;
            setStatus("waiting");
            setMsg("Waiting for funds…");
          },
        });
      } catch (e) {
        usdcBaselineRef.current = null;
        setStatus("error");
        setMsg(e instanceof Error ? e.message : "Couldn't open card funding.");
      }
    },
    [onramp],
  );

  return (
    <Screen topInset footerSpace={spacing.xl}>
      <UnifiedHeader
        variant="modal"
        chip={{ label: "Add USX", tone: "info" }}
        title="Deposit"
        onClose={onClose}
      />
      <View style={styles.path}>
        {onramp.supported ? (
          <View style={styles.cardBlock}>
            <Button
              label="Add with card"
              onPress={() => buy("stripe")}
              variant="primary"
              size="lg"
              fullWidth
              glow
              loading={status === "buying"}
              disabled={busy}
            />
          </View>
        ) : null}

        <DepositAddressCard address={chain.address ?? "—"} live network="Solana" />
        <TrustChecklist address={chain.address ?? undefined} done={status === "done"} />

        {msg ? (
          <Text style={[type.caption, status === "error" ? styles.errMsg : styles.okMsg]}>
            {msg}
          </Text>
        ) : null}

        {/* Fallback only (not the primary flow): if an auto-detect was missed —
            e.g. a direct USDC send that didn't change the SOL balance — let the
            user nudge the conversion. Subtle link, not a button. */}
        {status === "idle" || status === "error" ? (
          <Text
            style={[type.caption, styles.convertLink]}
            onPress={() => {
              doneRef.current = false;
              void autoConvert({ manual: true });
            }}
          >
            Convert to USX
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
          tag={demoTag ?? "Instant"}
          tint="cyan"
          selected={method === "card"}
          onPress={() => onMethod("card")}
        />
        {showApplePay ? (
          <MethodOption
            icon=""
            title="Apple Pay"
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
            Demo credit, no transfer
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
  cardBlock: { gap: spacing.sm, alignItems: "center" },
  simulate: {
    alignItems: "center",
    gap: spacing.sm,
  },
  simulateHint: { color: colors.textFaint, textAlign: "center" },
  trustProof: {
    ...type.caption,
    color: colors.cyan,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  okMsg: { color: colors.yes, textAlign: "center" },
  errMsg: { color: colors.no, textAlign: "center" },
  convertLink: { color: colors.cyan, textAlign: "center", textDecorationLine: "underline" },
});
