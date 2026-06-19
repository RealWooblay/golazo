import React from "react";
import { StyleSheet, View } from "react-native";
import { Chip, IconButton, IconClose, Text } from "@/ui";
import type { ChipTone } from "@/ui";
import { colors, spacing, type } from "@/theme";

/**
 * ModalHeader — the shared top bar for the deposit/withdraw money modals: a tone
 * chip on the left, a close button on the right, and a big title beneath. Keeps
 * the two flows visually identical so the experience reads as one system.
 */
export function ModalHeader({
  chip,
  chipTone = "info",
  title,
  onClose,
}: {
  chip: string;
  chipTone?: ChipTone;
  title: string;
  onClose: () => void;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Chip label={chip} tone={chipTone} />
        <IconButton accessibilityLabel="Close" onPress={onClose} haptic="tap">
          <IconClose size={20} color={colors.textMuted} />
        </IconButton>
      </View>
      <Text style={[type.display, styles.title]}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginBottom: spacing.lg, gap: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: colors.textPrimary },
});
