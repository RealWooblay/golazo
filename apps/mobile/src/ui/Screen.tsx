import React from "react";
import { ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, MAX_WIDTH, spacing } from "@/theme";

/**
 * Screen — the standard page frame: a FLAT near-black canvas (no full-screen wash and
 * no grain), safe-area padding, and content capped to the iPhone-width "app column" so
 * it stays tight on web/tablet.
 *
 * The accent lives SURGICALLY on live/active elements — never as a background bloom.
 * (The old tinted vignette + grain are gone; the `vignette` prop is accepted but ignored
 * so existing call sites keep compiling.)
 *
 * @param scroll   wrap children in a ScrollView (default true).
 * @param padded   apply horizontal gutter (spacing.lg) to the column (default true).
 * @param topInset add top safe-area padding (default true).
 * @param footerSpace extra bottom padding so the floating tab bar never overlaps.
 */
export function Screen({
  children,
  scroll = true,
  padded = true,
  topInset = true,
  footerSpace = 96,
  contentStyle,
}: {
  children?: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  /** @deprecated kept for call-site compatibility; the canvas is now flat. */
  vignette?: "neutral" | "yes" | "no" | "gold" | "cyan";
  topInset?: boolean;
  footerSpace?: number;
  contentStyle?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  const pad: ViewStyle = {
    paddingTop: topInset ? insets.top + spacing.sm : spacing.sm,
    paddingHorizontal: padded ? spacing.lg : 0,
  };

  const inner = (
    <View style={styles.column}>
      <View style={[pad, contentStyle]}>{children}</View>
    </View>
  );

  return (
    <View style={styles.root}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: footerSpace }]}
          showsVerticalScrollIndicator={false}
        >
          {inner}
        </ScrollView>
      ) : (
        <View style={styles.flex}>{inner}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, alignItems: "center" },
  scroll: { flexGrow: 1, alignItems: "center" },
  column: { width: "100%", maxWidth: MAX_WIDTH },
});
