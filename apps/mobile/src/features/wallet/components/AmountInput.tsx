import React, { useMemo } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Chip, Pressable, Text } from "@/ui";
import { colors, radius, spacing, type } from "@/theme";
import { haptics } from "@/ui/haptics";
import { money } from "@/lib/format";

/**
 * AmountInput — a big, confident money field. The dollar amount is rendered in
 * the tabular display face and grows/shrinks with length so it always reads as a
 * "number you're about to move", not a form input. A native (numeric) TextInput
 * is overlaid invisibly so the device keypad still drives it; tapping anywhere on
 * the number focuses it.
 *
 * Below sit quick-amount preset chips + an optional "Max" chip (off-ramp). A
 * caption line shows context ("Balance $1,000" / a friendly over-balance error).
 *
 * Value is a string of digits the parent owns; `onChange` receives the sanitised
 * digits-only string so the parent can `Number(value)` safely.
 */
export interface AmountInputProps {
  /** Digits-only string (no $, no commas). Parent owns it. */
  value: string;
  onChange: (next: string) => void;
  /** Quick presets in dollars. Tapping sets the value. */
  presets?: number[];
  /** Show a "Max" chip that fills `max`. */
  max?: number;
  /** Caption under the field (context or error). */
  caption?: string;
  /** Render the caption in the danger tone. */
  error?: boolean;
  /** Prefix glyph (default "$"). */
  prefix?: string;
  autoFocus?: boolean;
}

const DEFAULT_PRESETS = [25, 50, 100, 250];

function sanitize(raw: string): string {
  // digits only, strip leading zeros (keep a single 0), cap length.
  const digits = raw.replace(/[^0-9]/g, "").slice(0, 7);
  return digits.replace(/^0+(?=\d)/, "");
}

export function AmountInput({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  max,
  caption,
  error = false,
  prefix = "$",
  autoFocus = false,
}: AmountInputProps) {
  const inputRef = React.useRef<TextInput>(null);
  const numeric = Number(value || 0);

  // Shrink the display as the number grows so big amounts still fit on one line.
  const fontSize = useMemo(() => {
    const len = (value || "0").length;
    if (len <= 3) return 56;
    if (len === 4) return 48;
    if (len === 5) return 40;
    return 34;
  }, [value]);

  const focus = () => inputRef.current?.focus();

  const setPreset = (amount: number) => {
    haptics.selection();
    onChange(String(amount));
  };

  return (
    <View style={styles.root}>
      <Pressable onPress={focus} haptic={null} scaleTo={1} style={styles.field}>
        <Text
          style={[type.display, styles.prefix, { fontSize: fontSize * 0.6 }]}
        >
          {prefix}
        </Text>
        <Text
          style={[
            type.hero,
            styles.amount,
            {
              fontSize,
              lineHeight: fontSize * 1.05,
              color: numeric > 0 ? colors.textPrimary : colors.textFaint,
            },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {value === "" ? "0" : value}
        </Text>
        {/* Invisible real input driving the keypad. */}
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={(t) => onChange(sanitize(t))}
          keyboardType="number-pad"
          inputMode="numeric"
          autoFocus={autoFocus}
          caretHidden
          style={styles.hiddenInput}
          // Keep it focusable across web + native.
          maxLength={8}
        />
      </Pressable>

      {caption ? (
        <Text
          style={[type.caption, styles.caption, error && styles.captionError]}
        >
          {caption}
        </Text>
      ) : null}

      <View style={styles.presets}>
        {presets.map((p) => (
          <Chip
            key={p}
            label={money(p)}
            tone="info"
            selected={numeric === p}
            onPress={() => setPreset(p)}
          />
        ))}
        {typeof max === "number" && max > 0 ? (
          <Chip
            label="Max"
            tone="win"
            selected={numeric === Math.floor(max)}
            onPress={() => setPreset(Math.floor(max))}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  field: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingVertical: spacing.lg,
    minHeight: 96,
    borderRadius: radius.lg,
  },
  prefix: { color: colors.textMuted, marginTop: 6, marginRight: 2 },
  amount: { textAlign: "center" },
  hiddenInput: {
    position: "absolute",
    width: "100%",
    height: "100%",
    opacity: 0,
    color: "transparent",
  },
  caption: { color: colors.textMuted, textAlign: "center" },
  captionError: { color: colors.no },
  presets: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "center",
  },
});
