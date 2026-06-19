import React from "react";
import { ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, MAX_WIDTH, spacing } from "@/theme";
import { GrainOverlay } from "./GrainOverlay";
import { Vignette } from "./Vignette";

/**
 * Screen — the standard page frame: near-black canvas, a faint top vignette + a
 * whisper of grain for depth, safe-area padding, and the content capped to the
 * iPhone-width "app column" so it stays tight on web/tablet.
 *
 * Use it as the root of every screen so the canvas reads identically everywhere:
 *   <Screen>           // scrolls by default
 *     ...content
 *   </Screen>
 *
 * @param scroll   wrap children in a ScrollView (default true).
 * @param padded   apply horizontal gutter (spacing.lg) to the column (default true).
 * @param vignette tint of the top wash ('neutral' default; 'yes' for live hero).
 * @param topInset add top safe-area padding (default true).
 * @param footerSpace extra bottom padding so the floating tab bar never overlaps.
 */
export function Screen({
  children,
  scroll = true,
  padded = true,
  vignette = "neutral",
  topInset = true,
  footerSpace = 96,
  contentStyle,
}: {
  children?: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
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
      <Vignette
        tint={vignette}
        intensity={vignette === "neutral" ? 0.4 : 0.5}
      />
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: footerSpace },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {inner}
        </ScrollView>
      ) : (
        <View style={styles.flex}>{inner}</View>
      )}
      <GrainOverlay opacity={0.035} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, alignItems: "center" },
  scroll: { flexGrow: 1, alignItems: "center" },
  column: { width: "100%", maxWidth: MAX_WIDTH },
});
