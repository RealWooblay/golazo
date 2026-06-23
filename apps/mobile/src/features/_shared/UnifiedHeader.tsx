// UNIFIED HEADER — one header treatment for every screen, so the whole app reads
// as a single family. The existing per-screen headers (ScreenHeader, LobbyTopBar,
// MatchHeader, ModalHeader) were each legit but drifted on tokens — different
// title sizes (display vs title), different brand weights/sizes, different
// spacing. This consolidates them into ONE component with FOUR variants that all
// pull from a single styles object, so sizes/colours/spacing can never drift again.
//
// Variants:
//   • tab    — lobby/onboarding top bar: GOLAZO wordmark + a right slot.
//   • screen — profile/wallet/match static header: eyebrow + title, right/chip
//              baseline-aligned to the title. No back button.
//   • modal  — deposit/withdraw: a chip + close row, title beneath.
//   • slim   — friends/how-it-works: centered title between a left back/close and
//              an optional right slot.
//
// The shared brand colour (colors.yes — the lobby wordmark lime) ties the family
// together. Callers own the safe-area top inset (the 'tab' variant especially).
import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Chip, IconButton, IconBack, IconClose, Text } from "@/ui";
import type { ChipTone } from "@/ui";
import { colors, fontFamily, spacing, type } from "@/theme";

export type HeaderVariant = "tab" | "screen" | "modal" | "slim";

export interface UnifiedHeaderProps {
  variant: HeaderVariant;
  /** Shown on 'screen' / 'modal' / 'slim'. ('tab' shows the GOLAZO brand instead.) */
  title?: string;
  /** 'screen' only — a small overline above the title (colors.yes). Default none. */
  eyebrow?: string;
  /** 'slim' — a left back chevron. Ignored when onClose is set. */
  onBack?: () => void;
  /** 'modal' (right) / 'slim' (left) close button. Takes precedence over onBack. */
  onClose?: () => void;
  /** Right-side slot — balance pill, add-cash, etc. */
  right?: React.ReactNode;
  /** Optional status chip — sits right on 'screen', left on 'modal'. */
  chip?: { label: string; tone?: ChipTone; dot?: boolean };
  style?: ViewStyle;
}

export function UnifiedHeader({
  variant,
  title,
  eyebrow,
  onBack,
  onClose,
  right,
  chip,
  style,
}: UnifiedHeaderProps) {
  // Render the chip once — both 'screen' (right) and 'modal' (left) reuse it.
  const chipEl = chip ? (
    <Chip label={chip.label} tone={chip.tone ?? "neutral"} dot={chip.dot} />
  ) : null;

  // ── tab ────────────────────────────────────────────────────────────────────
  // One row: brand on the left, the right slot on the right.
  if (variant === "tab") {
    return (
      <View style={[styles.tabBar, style]}>
        <Text style={styles.brand} accessibilityRole="header">
          GOLAZO
        </Text>
        {right ? <View style={styles.rightSlot}>{right}</View> : null}
      </View>
    );
  }

  // ── modal ────────────────────────────────────────────────────────────────────
  // A chip + close row, with the title beneath.
  if (variant === "modal") {
    return (
      <View style={[styles.modalRoot, style]}>
        <View style={styles.modalRow}>
          {chipEl ?? <View />}
          {onClose ? (
            <IconButton accessibilityLabel="Close" onPress={onClose} haptic="tap">
              <IconClose size={20} color={colors.textMuted} />
            </IconButton>
          ) : null}
        </View>
        {title ? <Text style={styles.title}>{title}</Text> : null}
      </View>
    );
  }

  // ── slim ────────────────────────────────────────────────────────────────────
  // Centered title between a left back/close button and an optional right slot.
  // onClose takes precedence over onBack for the left glyph.
  if (variant === "slim") {
    return (
      <View style={[styles.slimBar, style]}>
        <View style={styles.slimLeft}>
          {onClose ? (
            <IconButton accessibilityLabel="Close" onPress={onClose} haptic="tap">
              <IconClose size={20} color={colors.textPrimary} />
            </IconButton>
          ) : onBack ? (
            <IconButton accessibilityLabel="Back" onPress={onBack} haptic="tap">
              <IconBack size={20} color={colors.textPrimary} />
            </IconButton>
          ) : (
            <View style={styles.slimSideSpacer} />
          )}
        </View>
        <Text
          style={[styles.slimTitleOverlay, { pointerEvents: "none" }]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
        <View style={styles.slimRight} pointerEvents="box-none">
          {right}
        </View>
      </View>
    );
  }

  // ── screen (default) ─────────────────────────────────────────────────────────
  // A left block of optional eyebrow + title, with the right slot (or chip)
  // baseline-aligned to the title on the right. No back button.
  return (
    <View style={[styles.screenHeader, style]}>
      <View style={styles.screenTitles}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        {title ? <Text style={styles.title}>{title}</Text> : null}
      </View>
      {right ?? chipEl ? (
        <View style={styles.screenAccessory}>{right ?? chipEl}</View>
      ) : null}
    </View>
  );
}

export default UnifiedHeader;

// SINGLE SOURCE OF TRUTH — every variant's sizes/colours/spacing live here, so the
// family can't drift. Title is type.title (22px) everywhere it appears — never the
// giant display face — for cross-screen consistency.
const styles = StyleSheet.create({
  // tab ----------------------------------------------------------------------
  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
  },
  brand: {
    fontFamily: fontFamily.display,
    color: colors.yes,
    fontWeight: "900",
    fontSize: 20,
    letterSpacing: 0.5,
  },
  rightSlot: { flexDirection: "row", alignItems: "center", gap: spacing.md },

  // screen -------------------------------------------------------------------
  screenHeader: {
    flexDirection: "row",
    // Bottom-align so a chip/accessory sits on the title's baseline rather than
    // floating against the eyebrow.
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  screenTitles: { gap: 2, flexShrink: 1 },
  eyebrow: { ...type.overline, color: colors.yes, letterSpacing: 2 },
  // Nudge the accessory up so it optically aligns with the title's cap height.
  screenAccessory: { paddingBottom: 4 },

  // modal --------------------------------------------------------------------
  modalRoot: { marginBottom: spacing.lg, gap: spacing.sm },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  // slim ---------------------------------------------------------------------
  slimBar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    position: "relative",
  },
  // Pin the back/close control so wide right-slot content can't steal taps.
  slimLeft: {
    width: 44,
    zIndex: 2,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  slimSideSpacer: { width: 44, height: 44 },
  slimTitleOverlay: {
    ...type.title,
    fontSize: 20,
    color: colors.textPrimary,
    position: "absolute",
    left: 56,
    right: 56,
    textAlign: "center",
    zIndex: 0,
  },
  slimRight: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    zIndex: 1,
  },

  // shared -------------------------------------------------------------------
  // The one title style — type.title (22px) — used by screen + modal.
  title: { ...type.title, color: colors.textPrimary },
});
