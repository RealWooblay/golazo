import React, { useState } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Pressable, Text } from "@/ui";
import { haptics } from "@/ui/haptics";
import { STAKE_CHIPS } from "@/lib/config";
import { money } from "@/lib/format";

/**
 * StakeRow — the quick-stake selector under the odds. Four tappable preset chips
 * ($10/$25/$50/$100) plus a "custom" chip that swaps in an inline numeric field.
 * The active preset gets a cyan selected tint; an out-of-balance stake reads red
 * so you know before you tap YES/NO. Disabled (greyed) once a bet is in.
 *
 * Controlled: the parent owns `stake`; we call `onChange` with the new amount.
 */
export function StakeRow({
  stake,
  onChange,
  balance,
  format = money,
  disabled,
  hapticsEnabled = true,
}: {
  stake: number;
  onChange: (n: number) => void;
  balance: number;
  /** Stake/balance formatter — SOL in chain mode, $ in sandbox. */
  format?: (n: number) => string;
  disabled?: boolean;
  hapticsEnabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");

  const isPreset = (STAKE_CHIPS as readonly number[]).includes(stake);
  const overBalance = stake > balance;

  const pick = (n: number) => {
    if (disabled) return;
    if (hapticsEnabled) haptics.selection();
    setCustom(false);
    onChange(n);
  };

  const commitCustom = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    if (n > 0) onChange(n);
    Keyboard.dismiss();
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {STAKE_CHIPS.map((n) => {
          const active = !custom && stake === n;
          return (
            <Pressable
              key={n}
              onPress={() => pick(n)}
              disabled={disabled}
              haptic={null}
              scaleTo={0.93}
              style={[
                styles.chip,
                active && styles.chipActive,
                disabled && styles.chipDisabled,
              ]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {format(n)}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => {
            if (disabled) return;
            if (hapticsEnabled) haptics.selection();
            setCustom((c) => !c);
            setDraft(isPreset ? "" : String(stake));
          }}
          disabled={disabled}
          haptic={null}
          scaleTo={0.93}
          style={[
            styles.chip,
            custom && styles.chipActive,
            disabled && styles.chipDisabled,
          ]}
        >
          <Text style={[styles.chipText, custom && styles.chipTextActive]}>
            ⋯
          </Text>
        </Pressable>
      </View>

      {custom ? (
        <View style={[styles.customRow, overBalance && styles.customRowOver]}>
          <TextInput
            value={draft}
            onChangeText={(t) => {
              const clean = t.replace(/[^0-9]/g, "");
              setDraft(clean);
              const n = Number(clean) || 0;
              if (n > 0) onChange(n);
            }}
            onBlur={commitCustom}
            onSubmitEditing={commitCustom}
            keyboardType="number-pad"
            placeholder="amount"
            placeholderTextColor={colors.textFaint}
            editable={!disabled}
            style={styles.input}
            maxLength={6}
            returnKeyType="done"
            accessibilityLabel="Custom stake amount"
          />
          <Text style={[styles.hint, overBalance && styles.hintOver]}>
            {overBalance ? "over balance" : `of ${format(balance)}`}
          </Text>
        </View>
      ) : overBalance ? (
        <Text style={styles.overText}>
          That's more than your {format(balance)} balance
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
  },
  chipActive: {
    borderColor: colors.glow.cyanSoft,
    backgroundColor: colors.alpha.cyan,
  },
  chipDisabled: { opacity: 0.4 },
  chipText: { ...type.subtitle, fontSize: 14, color: colors.textPrimary },
  chipTextActive: { color: colors.cyan },
  customRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.glow.cyanSoft,
  },
  customRowOver: { borderColor: colors.glow.noSoft },
  dollar: { ...type.subtitle, fontSize: 16, color: colors.textSecondary },
  input: {
    flex: 1,
    ...type.mono,
    fontSize: 18,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  hint: { ...type.caption, fontSize: 11, color: colors.textFaint },
  hintOver: { color: colors.no },
  overText: {
    ...type.caption,
    fontSize: 11,
    color: colors.no,
    paddingHorizontal: spacing.xs,
  },
});
