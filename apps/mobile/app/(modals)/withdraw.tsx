// OWNED BY: wallet agent (withdraw / off-ramp flow).
//
// Presented modally. Cash out, crypto-first and honest:
// • amount (capped at balance, with presets + Max), shown in $
// • destination — a single pasted Solana address (base58-validated). There's no
//   "my wallet" option: withdrawing to your own deposit address is a no-op. No
//   fake "demo bank" rail either.
// • review → confirm → success animation; debits via the off-ramp adapter.
//
// Validates against balance with friendly inline errors. Web-safe: ramp/browser
// shims lazy-require behind fallbacks.
import React, { useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { Screen, Text, Button, hapticIf } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import {
  AmountInput,
  FlowStatus,
  openExternal,
  useWallet,
} from "@/features/wallet";
import type { FlowStatusKind } from "@/features/wallet";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import { useChain } from "@/features/chain";
import {
  useDisplayBalance,
  SOL_PER_UNIT,
} from "@/features/chain/useDisplayBalance";
import { money } from "@/lib/format";

/** A plausible base58 Solana address: 32–44 chars, no 0/O/I/l (base58 charset). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isPlausibleSolanaAddress(addr: string): boolean {
  return BASE58_RE.test(addr.trim());
}

/** Local flow snapshot for the LIVE on-chain send (the sandbox path uses
 *  useWallet().flow; this drives the same <FlowStatus> for the real transfer). */
interface LiveFlow {
  status: FlowStatusKind; // "idle" | "pending" | "success" | "error"
  amount: number;
  message?: string;
  /** Explorer link to the confirmed tx (or the wallet address as a fallback). */
  txUrl?: string;
}

export default function WithdrawModal() {
  const router = useRouter();
  const { session } = useStore();
  const bal = useDisplayBalance(); // real on-chain $ in live mode, play $ otherwise
  const balance = bal.amount;
  const wallet = useWallet();
  const chain = useChain();

  const [amount, setAmount] = useState("");
  const [pasteAddr, setPasteAddr] = useState("");

  // LIVE on-chain send state. `bal.chain` (chain.ready && live mode) selects the
  // real-transfer path; otherwise we keep the existing sandbox runOfframp flow.
  const onChain = bal.chain;
  const [liveFlow, setLiveFlow] = useState<LiveFlow>({
    status: "idle",
    amount: 0,
  });

  const numeric = Number(amount || 0);
  const hapticsOn = session.hapticsOn;
  const inFlow = onChain
    ? liveFlow.status !== "idle"
    : wallet.flow.kind === "withdraw" && wallet.flow.status !== "idle";

  const overBalance = numeric > balance;
  // Crypto is the only rail, and the destination is a single pasted Solana
  // address — withdrawing to your own deposit wallet is pointless, so there's no
  // "my wallet" shortcut.
  const cryptoAddr = pasteAddr.trim();
  // The pasted address must be a plausible base58 Solana key (32–44, charset).
  // Empty/short → just "needs more"; non-empty but malformed → "doesn't look right".
  const pasteTouched = cryptoAddr.length > 0;
  const pasteInvalid = pasteTouched && !isPlausibleSolanaAddress(cryptoAddr);
  const needsAddr = !isPlausibleSolanaAddress(cryptoAddr);
  const canSubmit = numeric > 0 && !overBalance && !needsAddr;

  const caption = useMemo(() => {
    if (overBalance) return `That's more than your ${money(balance)} balance.`;
    return `${money(balance)} available`;
  }, [overBalance, balance]);

  const close = () => {
    wallet.resetFlow();
    setLiveFlow({ status: "idle", amount: 0 });
    router.back();
  };

  // REAL on-chain transfer: $ amount → SOL via SOL_PER_UNIT, send out of the
  // embedded wallet, then drive pending → success/error and surface a tx link.
  const submitLive = async () => {
    if (!isPlausibleSolanaAddress(cryptoAddr)) {
      // Belt-and-suspenders: the button is already gated, but never send to a
      // malformed address.
      hapticIf(hapticsOn, "error");
      return;
    }
    const sol = numeric * SOL_PER_UNIT;
    setLiveFlow({ status: "pending", amount: numeric });
    hapticIf(hapticsOn, "select");
    try {
      const res = await chain.withdrawSol(cryptoAddr, sol);
      // Prefer the signature's explorer URL from the TxResult; fall back to the
      // destination address page on explorer.
      const txUrl = res?.explorerUrl || chain.explorerAddressUrl(cryptoAddr);
      setLiveFlow({
        status: "success",
        amount: numeric,
        message: "Sent on-chain. Your balance is updated.",
        txUrl,
      });
      hapticIf(hapticsOn, "win");
    } catch (e) {
      setLiveFlow({
        status: "error",
        amount: numeric,
        message:
          e instanceof Error
            ? e.message
            : "The on-chain transfer didn't go through.",
      });
      hapticIf(hapticsOn, "error");
    }
  };

  const submit = () => {
    if (onChain) {
      void submitLive();
      return;
    }
    void wallet.runOfframp({
      amount: numeric,
      destination: "crypto",
      walletAddress: cryptoAddr,
      hapticsOn,
    });
  };

  if (inFlow) {
    const status = onChain ? liveFlow.status : wallet.flow.status;
    const flowAmount = onChain ? liveFlow.amount : wallet.flow.amount;
    const flowMessage = onChain ? liveFlow.message : wallet.flow.message;
    const txUrl = onChain ? liveFlow.txUrl : undefined;
    return (
      <Screen scroll={false} topInset>
        <UnifiedHeader
          variant="modal"
          chip={{ label: "Cash out", tone: "win" }}
          title="Withdraw"
          onClose={close}
        />
        <FlowStatus
          kind="withdraw"
          status={status}
          amount={flowAmount}
          message={flowMessage}
          onDone={close}
          onRetry={() => {
            if (onChain) {
              setLiveFlow({ status: "idle", amount: 0 });
              void submitLive();
            } else {
              wallet.resetFlow();
              submit();
            }
          }}
        />
        {txUrl && status === "success" ? (
          <View style={styles.txLinkWrap}>
            <Text
              onPress={() => void openExternal(txUrl)}
              style={[type.caption, styles.txLink]}
            >
              View transaction ↗
            </Text>
          </View>
        ) : null}
      </Screen>
    );
  }

  if (balance <= 0) {
    return (
      <Screen scroll={false} topInset>
        <UnifiedHeader
          variant="modal"
          chip={{ label: "Cash out", tone: "win" }}
          title="Withdraw"
          onClose={close}
        />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyGlyph}></Text>
          <Text style={[type.title, styles.emptyTitle]}>
            Nothing to cash out yet
          </Text>
          <Text style={[type.body, styles.emptyBody]}>
            Add funds and win a few markets, then come back to withdraw.
          </Text>
          <Button
            label="Add funds"
            onPress={() => router.replace("/(modals)/deposit")}
            variant="primary"
            size="lg"
            fullWidth
            glow
            style={styles.emptyCta}
          />
        </View>
      </Screen>
    );
  }

  // "Live" copy/review tracks the REAL on-chain send path (chain.ready && live
  // mode), not just whether ramp keys exist.
  const isLive = onChain;

  return (
    <Screen topInset footerSpace={spacing.xl}>
      <UnifiedHeader
        variant="modal"
        chip={{ label: "Cash out", tone: "win" }}
        title="Withdraw"
        onClose={close}
      />

      <View style={styles.amountBlock}>
        <AmountInput
          value={amount}
          onChange={setAmount}
          presets={presetsFor(balance)}
          max={balance}
          caption={caption}
          error={overBalance}
          autoFocus
        />
      </View>

      <View style={styles.cryptoBox}>
        <Text style={[type.overline, styles.methodsLabel]}>
          Send to a Solana wallet
        </Text>
        <TextInput
          value={pasteAddr}
          onChangeText={setPasteAddr}
          placeholder="Paste a Solana address"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={[type.mono, styles.input]}
        />
        {pasteInvalid ? (
          <Text style={[type.caption, styles.addrHint]}>
            That doesn't look like a Solana address. Check it and try again.
          </Text>
        ) : needsAddr ? (
          <Text style={[type.caption, styles.addrHint]}>
            Enter a valid Solana address to continue.
          </Text>
        ) : null}
      </View>

      {/* Review summary. Sandbox has no fee (play money); live fees are set by
          the network at send time — so we don't fabricate a "$0.00". */}
      <View style={styles.review}>
        <ReviewRow label="Amount" value={money(numeric)} />
        <ReviewRow label="To" value="Crypto wallet" />
        <ReviewRow
          label="Fee"
          value={isLive ? "Network fee" : "$0.00"}
          accent
        />
        <View style={styles.reviewDivider} />
        <ReviewRow
          label="You receive"
          value={isLive ? "Quoted at send" : money(numeric)}
          strong
        />
      </View>

      <View style={styles.footer}>
        <Button
          label={numeric > 0 ? `Cash out ${money(numeric)}` : "Enter an amount"}
          onPress={submit}
          variant="primary"
          size="lg"
          fullWidth
          glow
          disabled={!canSubmit}
        />
        <Text style={[type.caption, styles.legal]}>
          {isLive
            ? "Sent on-chain to the address above. Network fees apply."
            : "Demo mode — no real funds move. Debits your play balance."}
        </Text>
      </View>
    </Screen>
  );
}

function ReviewRow({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={styles.reviewRow}>
      <Text style={[type.caption, styles.reviewLabel]}>{label}</Text>
      <Text
        style={[
          strong ? type.bodyStrong : type.caption,
          {
            color: accent
              ? colors.yes
              : strong
                ? colors.textPrimary
                : colors.textSecondary,
          },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/** Presets that make sense relative to the balance (¼, ½, ¾, all). */
function presetsFor(balance: number): number[] {
  const out = [
    Math.floor(balance * 0.25),
    Math.floor(balance * 0.5),
    Math.floor(balance * 0.75),
  ].filter((n) => n >= 5);
  return Array.from(new Set(out));
}

const styles = StyleSheet.create({
  amountBlock: { marginTop: spacing.lg },
  methodsLabel: { color: colors.textMuted, marginBottom: spacing.xs },
  cryptoBox: {
    gap: spacing.sm,
    padding: spacing.md,
    marginTop: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface0,
  },
  input: {
    color: colors.textPrimary,
    fontSize: 15,
    paddingVertical: spacing.sm,
  },
  addrHint: { color: colors.no },
  review: {
    padding: spacing.lg,
    marginTop: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface0,
    gap: spacing.sm,
  },
  reviewRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reviewLabel: { color: colors.textMuted },
  reviewDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
    marginVertical: spacing.xs,
  },
  footer: { marginTop: spacing.xl, gap: spacing.sm },
  legal: { color: colors.textFaint, textAlign: "center" },
  txLinkWrap: { alignItems: "center", marginTop: -spacing.lg },
  txLink: { color: colors.cyan, fontWeight: "700", padding: spacing.sm },
  emptyWrap: {
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.huge,
  },
  emptyGlyph: { fontSize: 48, opacity: 0.9 },
  emptyTitle: { color: colors.textPrimary, textAlign: "center" },
  emptyBody: { color: colors.textMuted, textAlign: "center", maxWidth: 280 },
  emptyCta: { marginTop: spacing.lg, alignSelf: "stretch" },
});
