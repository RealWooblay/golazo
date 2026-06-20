import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Button, Chip, Surface, Text } from "@/ui";
import { useAccount } from "./useAccount";

/** Shorten a base58 address for display: `7xKQ…9fL2`. */
function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/**
 * ACCOUNT card (Profile) — the Privy-backed sign-in surface.
 *
 * Signed out: pitches the value (login → a wallet that follows you across
 * devices, no seed phrase) and opens the Privy login modal. Signed in: shows the
 * handle + the embedded Solana wallet address and a sign-out. Renders nothing
 * when Privy isn't configured/available (native), so the legacy wallet stands.
 */
export function AccountCard({ noTopMargin }: { noTopMargin?: boolean } = {}) {
  const account = useAccount();

  // Privy off (native or no app id) — fall back to the legacy embedded wallet.
  if (!account.enabled) return null;
  // Privy still booting — hold the space quietly rather than flash the CTA.
  if (!account.ready) return null;

  const sectionStyle = noTopMargin ? styles.sectionFlush : styles.section;

  if (!account.authenticated) {
    return (
      <View style={sectionStyle}>
        <Surface glow="cyan" style={styles.card}>
          <Text preset="overline" style={styles.over}>
            ACCOUNT
          </Text>
          <Text preset="subtitle">Save your wallet</Text>
          <Text preset="body" muted style={styles.body}>
            Sign in with email, Google or a passkey. Your Solana wallet follows
            you to any device — no seed phrase to write down or lose.
          </Text>
          <Button
            label="Sign in"
            onPress={account.login}
            variant="primary"
            fullWidth
            glow
          />
        </Surface>
      </View>
    );
  }

  return (
    <View style={sectionStyle}>
      <Surface glow="yes" style={styles.card}>
        <View style={styles.headRow}>
          <Text preset="overline" style={styles.over}>
            ACCOUNT
          </Text>
          <Chip label="Signed in" tone="neutral" />
        </View>
        {account.handle ? (
          <Text preset="subtitle" numberOfLines={1}>
            {account.handle}
          </Text>
        ) : null}
        {account.solanaAddress ? (
          <View style={styles.addrRow}>
            <Text preset="caption" faint>
              Wallet
            </Text>
            <Text preset="mono" style={styles.addr}>
              {shortAddr(account.solanaAddress)}
            </Text>
          </View>
        ) : (
          <Text preset="caption" muted style={styles.body}>
            Setting up your wallet…
          </Text>
        )}
        <Button
          label="Sign out"
          onPress={() => account.logout()}
          variant="ghost"
          fullWidth
        />
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.xxl },
  sectionFlush: { marginTop: 0 },
  card: { padding: spacing.lg, borderRadius: radius.lg, gap: spacing.sm },
  over: { color: colors.textFaint },
  body: { marginBottom: spacing.xs },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addrRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  addr: { ...type.mono, color: colors.textPrimary },
});
