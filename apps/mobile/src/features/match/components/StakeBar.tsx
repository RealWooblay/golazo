import React, { useState } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { colors, radius, spacing, type } from "@/theme";
import { Pressable, Text } from "@/ui";
import { haptics } from "@/ui/haptics";
import { STAKE_CHIPS } from "@/lib/config";
import { money } from "@/lib/format";

/**
 * StakeBar — ONE global stake selector for the whole match. Preset chips plus a
 * STICKY custom chip: enter an amount once and it stays a one-tap chip for the rest
 * of the session (never resets between bets). Mode-aware via `format` ($ vs points).
 *
 * Controlled: the parent owns `stake` (current selection) + `customStake` (the
 * remembered custom value); we call `onPick` / `onCustom`.
 */
export function StakeBar({
  stake,
  onPick,
  customStake,
  onCustom,
  balance,
  format = money,
  disabled = false,
  hapticsEnabled = true,
}: {
  stake: number;
  onPick: (n: number) => void;
  customStake: number;
  onCustom: (n: number) => void;
  balance: number;
  format?: (n: number) => string;
  disabled?: boolean;
  hapticsEnabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const presets = STAKE_CHIPS as readonly number[];
  const hasCustom = customStake > 0 && !presets.includes(customStake);
  const customActive = !editing && hasCustom && stake === customStake;
  const overBalance = stake > balance;

  const pick = (n: number) => {
    if (disabled) return;
    if (hapticsEnabled) haptics.selection();
    setEditing(false);
    onPick(n);
  };
  const openEdit = () => {
    if (disabled) return;
    if (hapticsEnabled) haptics.selection();
    setDraft(hasCustom ? String(customStake) : "");
    setEditing(true);
  };
  const commit = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    setEditing(false);
    Keyboard.dismiss();
    if (n > 0) {
      onCustom(n);
      onPick(n);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>YOUR STAKE</Text>
      <View style={styles.row}>
        {presets.map((n) => {
          const active = !editing && stake === n;
          return (
            <Pressable
              key={n}
              onPress={() => pick(n)}
              disabled={disabled}
              haptic={null}
              scaleTo={0.93}
              style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{format(n)}</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => {
            if (disabled) return;
            if (hasCustom && !customActive) pick(customStake);
            else openEdit();
          }}
          disabled={disabled}
          haptic={null}
          scaleTo={0.93}
          style={[
            styles.chip,
            (customActive || (editing && !hasCustom)) && styles.chipActive,
            disabled && styles.chipDisabled,
          ]}
          accessibilityLabel={hasCustom ? "Custom stake" : "Set a custom stake"}
        >
          <Text style={[styles.chipText, (customActive || editing) && styles.chipTextActive]}>
            {hasCustom ? format(customStake) : "+"}
          </Text>
        </Pressable>
      </View>

      {editing ? (
        <View style={[styles.customRow, overBalance && styles.customRowOver]}>
          <TextInput
            value={draft}
            onChangeText={(t) => setDraft(t.replace(/[^0-9]/g, ""))}
            onSubmitEditing={commit}
            keyboardType="number-pad"
            placeholder="custom amount"
            placeholderTextColor={colors.textFaint}
            editable={!disabled}
            autoFocus
            style={styles.input}
            maxLength={7}
            returnKeyType="done"
            accessibilityLabel="Custom stake amount"
          />
          <Pressable onPress={commit} haptic="select" scaleTo={0.95} style={styles.setBtn}>
            <Text style={styles.setText}>Set</Text>
          </Pressable>
        </View>
      ) : overBalance ? (
        <Text style={styles.overText}>That's more than your {format(balance)} balance</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: {
    ...type.overline,
    fontSize: 8,
    color: colors.textFaint,
    letterSpacing: 1.2,
    paddingHorizontal: spacing.xs,
  },
  row: { flexDirection: "row", gap: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
  },
  chipActive: { borderColor: colors.glow.yesSoft, backgroundColor: colors.alpha.yes },
  chipDisabled: { opacity: 0.4 },
  chipText: { ...type.subtitle, fontSize: 14, color: colors.textPrimary },
  chipTextActive: { color: colors.yes },
  customRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: 6,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.glow.yesSoft,
  },
  customRowOver: { borderColor: colors.glow.noSoft },
  input: { flex: 1, ...type.mono, fontSize: 17, color: colors.textPrimary, paddingVertical: 0 },
  setBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: colors.alpha.yes,
  },
  setText: { ...type.subtitle, fontSize: 13, color: colors.yes },
  overText: { ...type.caption, fontSize: 11, color: colors.no, paddingHorizontal: spacing.xs },
});
