import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { money } from "@/lib/format";
import { Button, Text } from "@/ui";
import { GradientFill } from "../_shared/primitives";

/**
 * StartPanel — the frictionless finish of onboarding (Rainbet-style: instant in,
 * link a wallet later). An optional display-name field, a clear "starter stack"
 * callout so the player knows they can play immediately, and the glowing primary
 * CTA. No required fields — the loop is the product.
 */
export function StartPanel({
  name,
  onChangeName,
  startBalance,
  onStart,
}: {
  name: string;
  onChangeName: (v: string) => void;
  startBalance: number;
  onStart: () => void;
}) {
  return (
    <View style={styles.wrap}>
      {/* starter stack callout */}
      <View style={styles.stack}>
        <GradientFill
          colors={["rgba(0,229,138,0.16)", "rgba(22,198,255,0.08)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
        <View style={styles.stackText}>
          <Text style={styles.stackLabel}>STARTER STACK · ON THE HOUSE</Text>
          <Text style={styles.stackValue} allowFontScaling={false}>
            {money(startBalance)}
          </Text>
        </View>
        <View style={styles.coin}>
          <Text style={styles.coinGlyph}></Text>
        </View>
      </View>

      {/* optional name */}
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
        label="Start playing"
        onPress={onStart}
        variant="primary"
        size="lg"
        fullWidth
        glow
        haptic="win"
      />
      <Text preset="caption" faint center style={styles.fine}>
        Play money to start. Link a wallet or cash out any time.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.lg },
  stack: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(0,229,138,0.28)",
    overflow: "hidden",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  stackText: { gap: 2 },
  stackLabel: { ...type.overline, color: colors.yes, fontSize: 9 },
  stackValue: { ...type.display, color: colors.textPrimary, fontSize: 30 },
  coin: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.alpha.yes,
    borderWidth: 1,
    borderColor: "rgba(0,229,138,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  coinGlyph: { fontSize: 20 },
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
