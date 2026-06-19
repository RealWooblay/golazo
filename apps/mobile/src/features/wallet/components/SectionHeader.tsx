import React from "react";
import { StyleSheet, View } from "react-native";
import { Pressable, Text } from "@/ui";
import { colors, spacing, type } from "@/theme";

/**
 * SectionHeader — a small overline title with an optional right-aligned action
 * ("See all", "How it works"). Keeps the wallet screen's section rhythm
 * consistent without re-deriving spacing each time.
 */
export function SectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={[type.overline, styles.title]}>{title}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} haptic="tap" scaleTo={0.96}>
          <Text style={[type.caption, styles.action]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: colors.textMuted },
  action: { color: colors.cyan },
});
