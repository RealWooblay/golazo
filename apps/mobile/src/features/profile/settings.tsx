import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { colors, motion, radius, spacing, type } from "@/theme";
import { Text } from "@/ui";
import { hapticIf } from "@/ui/haptics";
import { PressableScale } from "../_shared/primitives";

/**
 * SETTINGS — the row vocabulary for the Profile settings block. A grouped-card
 * container plus polished rows: an animated Toggle, a two-option Segment (mode),
 * a Link (chevron) row, and an inline-editable text field row (live feed URL).
 * Each carries an optional leading glyph + a sub-label. Web-safe.
 */

export function SettingsGroup({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.groupWrap}>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.group}>
        <View pointerEvents="none" style={styles.topHighlight} />
        {items.map((child, i) => (
          <View key={i}>
            {i > 0 ? <View style={styles.sep} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  );
}

function RowShell({
  glyph,
  title,
  sub,
  right,
  onPress,
  hapticsEnabled,
  danger,
}: {
  glyph?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  hapticsEnabled?: boolean;
  danger?: boolean;
}) {
  const content = (
    <View style={styles.row}>
      {glyph ? (
        <View style={styles.glyph}>
          <Text style={styles.glyphText}>{glyph}</Text>
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text
          preset="bodyStrong"
          color={danger ? colors.no : colors.textPrimary}
          numberOfLines={1}
        >
          {title}
        </Text>
        {sub ? (
          <Text preset="caption" faint numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );

  if (!onPress) return content;
  return (
    <PressableScale
      depth="subtle"
      haptic="tap"
      hapticsEnabled={hapticsEnabled}
      onPress={onPress}
    >
      {content}
    </PressableScale>
  );
}

export function ToggleRow({
  glyph,
  title,
  sub,
  value,
  onChange,
  hapticsEnabled,
}: {
  glyph?: string;
  title: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hapticsEnabled?: boolean;
}) {
  return (
    <RowShell
      glyph={glyph}
      title={title}
      sub={sub}
      hapticsEnabled={hapticsEnabled}
      onPress={() => {
        hapticIf(hapticsEnabled, "selection");
        onChange(!value);
      }}
      right={<Switch value={value} />}
    />
  );
}

function Switch({ value }: { value: boolean }) {
  const t = useDerivedValue(
    () => withSpring(value ? 1 : 0, motion.spring.snappy),
    [value],
  );
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      t.value,
      [0, 1],
      [colors.surface3, colors.yes],
    ),
  }));
  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [2, 22]) }],
  }));
  return (
    <Animated.View style={[styles.track, trackStyle]}>
      <Animated.View style={[styles.knob, knobStyle]} />
    </Animated.View>
  );
}

export function SegmentRow<T extends string>({
  glyph,
  title,
  sub,
  value,
  options,
  onChange,
  hapticsEnabled,
}: {
  glyph?: string;
  title: string;
  sub?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hapticsEnabled?: boolean;
}) {
  return (
    <RowShell
      glyph={glyph}
      title={title}
      sub={sub}
      right={
        <View style={styles.segment}>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <PressableScale
                key={o.value}
                depth="subtle"
                haptic="select"
                hapticsEnabled={hapticsEnabled}
                onPress={() => onChange(o.value)}
                style={[styles.segOpt, active && styles.segOptActive]}
              >
                <Text
                  style={[
                    type.overline,
                    {
                      fontSize: 10,
                      color: active ? colors.onYes : colors.textMuted,
                    },
                  ]}
                >
                  {o.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>
      }
    />
  );
}

export function LinkRow({
  glyph,
  title,
  sub,
  onPress,
  hapticsEnabled,
  danger,
}: {
  glyph?: string;
  title: string;
  sub?: string;
  onPress: () => void;
  hapticsEnabled?: boolean;
  danger?: boolean;
}) {
  return (
    <RowShell
      glyph={glyph}
      title={title}
      sub={sub}
      onPress={onPress}
      hapticsEnabled={hapticsEnabled}
      danger={danger}
      right={
        <View style={[styles.chevron, danger && { borderColor: colors.no }]} />
      }
    />
  );
}

export function FieldRow({
  glyph,
  title,
  value,
  placeholder,
  onChangeText,
  editable = true,
}: {
  glyph?: string;
  title: string;
  value: string;
  placeholder?: string;
  onChangeText: (v: string) => void;
  editable?: boolean;
}) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldHead}>
        {glyph ? (
          <View style={styles.glyph}>
            <Text style={styles.glyphText}>{glyph}</Text>
          </View>
        ) : null}
        <Text preset="bodyStrong">{title}</Text>
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, !editable && { opacity: 0.55 }]}
        selectionColor={colors.cyan}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  groupWrap: { gap: spacing.sm },
  groupTitle: {
    ...type.overline,
    color: colors.textMuted,
    fontSize: 9,
    marginLeft: spacing.xs,
  },
  group: {
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
    zIndex: 1,
  },
  sep: {
    height: 1,
    backgroundColor: colors.hairlineSoft,
    marginLeft: spacing.md + 30 + spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  glyph: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphText: { fontSize: 15 },
  rowText: { flex: 1, gap: 1 },
  right: { marginLeft: spacing.sm },
  // switch
  track: { width: 44, height: 26, borderRadius: 13, justifyContent: "center" },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  // segment
  segment: {
    flexDirection: "row",
    backgroundColor: colors.surface2,
    borderRadius: radius.pill,
    padding: 2,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
  },
  segOpt: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  segOptActive: { backgroundColor: colors.yes },
  // chevron
  chevron: {
    width: 8,
    height: 8,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.textFaint,
    transform: [{ rotate: "45deg" }],
  },
  // field
  fieldRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  fieldHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  input: {
    ...type.mono,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
