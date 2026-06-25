import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { POINTS_START_BALANCE } from "@golazo/core";
import { colors, radius, spacing, type } from "@/theme";
import { pts } from "@/lib/format";
import { Button, Text } from "@/ui";

/**
 * StartPanel — frictionless onboarding finish. Paper trade by default: live
 * feed, fake points, global rank — no real money required.
 */
export function StartPanel({
  name,
  onChangeName,
  onStart,
}: {
  name: string;
  onChangeName: (v: string) => void;
  onStart: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.stack}>
        <View style={styles.stackText}>
          <Text style={styles.stackLabel}>PAPER TRADE MODE</Text>
          <Text style={styles.stackValue} allowFontScaling={false}>
            {pts(POINTS_START_BALANCE)}
          </Text>
          <Text style={styles.stackSub}>
            Live moments · fake points · real leaderboard
          </Text>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>WHAT SHOULD WE CALL YOU?</Text>
        <TextInput
          value={name}
          onChangeText={onChangeName}
          placeholder="Pick a handle (optional)"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          maxLength={20}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          selectionColor={colors.yes}
        />
      </View>

      <Button
        label="Start paper trading"
        onPress={onStart}
        variant="primary"
        size="lg"
        fullWidth
        glow={false}
        haptic="win"
      />
      <Text preset="caption" faint center style={styles.fine}>
        No real money. Switch to Real mode later for devnet SOL.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Sections stack on the flat canvas — no panel card / gradient / coloured edge.
  wrap: { gap: spacing.lg },
  // The starter stack is the one flat Surface: surface1 fill + hairline only.
  stack: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  stackText: { gap: 4 },
  stackLabel: { ...type.overline, color: colors.textMuted, fontSize: 9 },
  stackValue: { ...type.display, color: colors.textPrimary, fontSize: 30 },
  stackSub: { ...type.caption, color: colors.textMuted, fontSize: 12 },
  field: { gap: spacing.sm },
  fieldLabel: { ...type.overline, color: colors.textMuted, fontSize: 9 },
  input: {
    ...type.subtitle,
    color: colors.textPrimary,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
  },
  fine: { marginTop: spacing.xs },
});
