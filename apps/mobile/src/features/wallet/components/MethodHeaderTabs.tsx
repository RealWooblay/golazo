import React from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from "react-native-reanimated";
import { Pressable, Text } from "@/ui";
import { colors, radius, spacing, spring, type } from "@/theme";

/**
 * MethodHeaderTabs — a compact segmented control for switching between the two
 * top-level funding/cash-out paths (Card vs Crypto, Bank vs Crypto). A pill
 * "thumb" springs under the active segment; tapping fires a selection haptic.
 *
 * Generic over the tab id so both modals can use their own union type. The thumb
 * width is computed from the segment count so it stays even.
 */
export interface TabItem {
  id: string;
  label: string;
}

export function MethodHeaderTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}) {
  const index = Math.max(
    0,
    tabs.findIndex((t) => t.id === active),
  );
  const n = tabs.length;
  const [trackW, setTrackW] = React.useState(0);
  const pos = useDerivedValue(() => withSpring(index, spring.snappy), [index]);

  // Inner width available to the thumbs (track padding is 4px each side).
  const segW = trackW > 0 ? (trackW - 8) / n : 0;

  const thumbStyle = useAnimatedStyle(() => ({
    width: segW,
    transform: [{ translateX: pos.value * segW }],
  }));

  return (
    <View
      style={styles.track}
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
    >
      {segW > 0 ? (
        <Animated.View
          style={[styles.thumb, thumbStyle]}
          pointerEvents="none"
        />
      ) : null}
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <Pressable
            key={t.id}
            onPress={() => onChange(t.id)}
            haptic="selection"
            scaleTo={1}
            style={styles.seg}
          >
            <Text
              style={[
                type.bodyStrong,
                styles.label,
                { color: selected ? colors.textPrimary : colors.textMuted },
              ]}
              numberOfLines={1}
            >
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface0,
    borderWidth: 1,
    borderColor: colors.hairline,
    position: "relative",
  },
  thumb: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
  },
  seg: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
  },
  label: { textAlign: "center" },
});
