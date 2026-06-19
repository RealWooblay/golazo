// SHARED SCREEN HEADER — the one header treatment every standard tab uses, so
// Wallet / Profile (and any future tab) read as the same family: a GOLAZO
// eyebrow over a big display title, with an optional right-aligned accessory
// (a status chip, an action) baseline-aligned to the title.
//
// The Play/Lobby tab is the deliberate exception — it's the home, so it keeps a
// sticky, balance-forward top bar (LobbyTopBar) instead of a static title. The
// shared brand colour (colors.yes, matching the lobby wordmark) ties them together.
import React from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors, spacing, type } from "@/theme";

export function ScreenHeader({
  title,
  eyebrow = "GOLAZO",
  accessory,
  style,
}: {
  /** The screen name — large display title. */
  title: string;
  /** Uppercase brand/context line above the title. Defaults to the wordmark. */
  eyebrow?: string;
  /** Optional right-side element (status chip, action), aligned to the title. */
  accessory?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.titles}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    // Align the accessory to the bottom of the block so a chip sits on the
    // title's baseline rather than floating against the eyebrow.
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  titles: { gap: 2, flexShrink: 1 },
  eyebrow: { ...type.overline, color: colors.yes, letterSpacing: 2 },
  title: { ...type.display, color: colors.textPrimary },
  // Nudge the accessory up so it optically aligns with the title's cap height.
  accessory: { paddingBottom: 6 },
});
