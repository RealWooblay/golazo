import React from "react";
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors } from "@/theme";

/**
 * Blur — a thin, dependency-tolerant wrapper for the frosted overlays/sheets the
 * brief calls for (reveal scrim, lock veil, win/lose flash backdrops).
 *
 * WHY a wrapper: `expo-blur` gives the real frosted-glass look on iOS/Android,
 * but (a) it isn't always available at module-load time on web and (b) a hard
 * top-level `import` of a native-only module can break the Expo WEB build we
 * verify against. So we:
 *   • require() expo-blur lazily inside a try/catch (never at module scope), and
 *   • fall back to a tuned translucent fill (`tint`-aware) when it's absent.
 *
 * The fallback is good enough that the screen reads identically in screenshots;
 * the real blur is a progressive enhancement on device.
 */

type Tint = "dark" | "light";

// Resolve expo-blur once, defensively. Any failure → null → translucent fallback.
let ExpoBlurView: React.ComponentType<{
  intensity?: number;
  tint?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ExpoBlurView = require("expo-blur").BlurView ?? null;
} catch {
  ExpoBlurView = null;
}

export function Blur({
  intensity = 24,
  tint = "dark",
  style,
  children,
}: {
  intensity?: number;
  tint?: Tint;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  // On web, even when expo-blur exists, the translucent fill is steadier across
  // browsers — keep it predictable for screenshot verification.
  if (ExpoBlurView && Platform.OS !== "web") {
    return (
      <ExpoBlurView intensity={intensity} tint={tint} style={style}>
        {children}
      </ExpoBlurView>
    );
  }
  const fallback =
    tint === "light" ? "rgba(244,246,251,0.10)" : colors.alpha.black60;
  return (
    <View style={[styles.fallback, { backgroundColor: fallback }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { overflow: "hidden" },
});
