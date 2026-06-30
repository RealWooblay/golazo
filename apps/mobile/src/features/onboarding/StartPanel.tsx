import React from "react";
import { StyleSheet, View } from "react-native";
import { colors, spacing, type } from "@/theme";
import { Button, Text } from "@/ui";

/**
 * StartPanel — frictionless onboarding finish.
 */
export function StartPanel({
  onStart,
}: {
  onStart: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <Button
        label="Start trading"
        onPress={onStart}
        variant="primary"
        size="lg"
        fullWidth
        glow={false}
        haptic="win"
      />
      <Text preset="caption" faint center style={styles.fine}>
        Paper mode first. Switch to USX anytime.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.lg },
  fine: { ...type.caption, color: colors.textFaint, marginTop: spacing.xs },
});
