import React, { useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Button, Chip, Pressable, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { copyToClipboard } from "@/features/wallet/platform";
import {
  normalizeReferralCode,
  useReferralProfile,
  type ReferralSummary,
} from "./useReferralProfile";

function referralShareUrl(code: string): string {
  const path = `/?ref=${encodeURIComponent(code)}`;
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

function usx(n: number): string {
  if (!Number.isFinite(n)) return "0.00 USX";
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USX`;
}

function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function EarningsGrid({ summary }: { summary: ReferralSummary }) {
  return (
    <View style={styles.stats}>
      <Stat label="Referred" value={compact(summary.attributedUsers)} />
      <Stat label="Volume" value={usx(summary.volume)} />
      <Stat label="Unpaid" value={usx(summary.referrerUnpaid)} tone="gold" />
      <Stat label="Paid" value={usx(summary.referrerPaid)} />
    </View>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "gold";
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone === "gold" && styles.gold]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function ReferralPanel() {
  const refs = useReferralProfile();
  const [inviteDraft, setInviteDraft] = useState("");
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const myCode = refs.myCode;
  const shareUrl = useMemo(() => (myCode ? referralShareUrl(myCode) : ""), [myCode]);

  const copyText = async (kind: "code" | "link", text: string) => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(kind);
    setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1400);
  };

  const applyInvite = () => {
    void refs.applyCode(inviteDraft).then((ok) => {
      if (ok) setInviteDraft("");
    });
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text preset="subtitle">Referrals</Text>
        {refs.attribution ? <Chip label={`Referred by ${refs.attribution.code}`} tone="live" /> : null}
      </View>

      <View style={styles.block}>
        <Text style={styles.kicker}>YOUR CODE</Text>
        {myCode ? (
          <>
            <Pressable
              onPress={() => copyText("code", myCode)}
              style={styles.codeHero}
              haptic="tap"
            >
              <Text style={styles.codeValue}>{myCode}</Text>
              <Text preset="caption" muted style={styles.copyHint}>
                {copied === "code" ? "Copied ✓" : "Tap to copy code"}
              </Text>
            </Pressable>
            {shareUrl ? (
              <Pressable
                onPress={() => copyText("link", shareUrl)}
                style={styles.linkRow}
                haptic="tap"
              >
                <View style={styles.linkText}>
                  <Text style={styles.linkLabel}>Share link</Text>
                  <Text style={styles.linkValue} numberOfLines={2}>
                    {shareUrl}
                  </Text>
                </View>
                <Text style={styles.copyAction}>
                  {copied === "link" ? "copied ✓" : "copy"}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <View style={styles.empty}>
            <Text preset="caption" muted>
              {refs.loading ? "Loading your code…" : "Sign in to get your referral code."}
            </Text>
          </View>
        )}
      </View>

      {refs.mySummary ? (
        <View style={styles.block}>
          <Text style={styles.kicker}>YOUR EARNINGS</Text>
          <EarningsGrid summary={refs.mySummary} />
        </View>
      ) : null}

      {!refs.attribution ? (
        <View style={styles.block}>
          <Text style={styles.kicker}>REFERRED BY</Text>
          <View style={styles.inputRow}>
            <TextInput
              value={inviteDraft}
              onChangeText={(v) => setInviteDraft(normalizeReferralCode(v))}
              placeholder="Enter code"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={32}
              selectionColor={colors.yes}
              onSubmitEditing={applyInvite}
            />
            <Button
              label="Apply"
              onPress={applyInvite}
              variant="secondary"
              size="sm"
              disabled={refs.loading}
              loading={refs.loading}
              flat
              style={styles.action}
            />
          </View>
        </View>
      ) : null}

      {refs.message ? <Text style={styles.message}>{refs.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    flexWrap: "wrap",
  },
  block: { gap: spacing.sm },
  kicker: { ...type.overline, color: colors.textFaint, fontSize: 8 },
  codeHero: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    gap: spacing.xs,
  },
  codeValue: { ...type.display, color: colors.gold, fontSize: 24, letterSpacing: 2 },
  copyHint: { fontSize: 11 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  input: {
    ...type.subtitle,
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
  },
  action: { alignSelf: "stretch" },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  linkText: { flex: 1, minWidth: 0, gap: 2 },
  linkLabel: { ...type.overline, color: colors.textFaint, fontSize: 8 },
  linkValue: { ...type.mono, color: colors.textPrimary, fontSize: 11, lineHeight: 15 },
  copyAction: { ...type.caption, fontSize: 12, color: colors.yes },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  stat: {
    flexGrow: 1,
    width: "47%",
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 3,
  },
  statLabel: { ...type.overline, color: colors.textFaint, fontSize: 8 },
  statValue: { ...type.display, color: colors.textPrimary, fontSize: 18 },
  gold: { color: colors.gold },
  empty: {
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  message: { ...type.caption, color: colors.textMuted },
});
