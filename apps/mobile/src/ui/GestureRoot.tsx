import React from "react";
import { StyleSheet, View } from "react-native";

/**
 * GestureRoot — the single root container that gesture-driven primitives
 * (@gorhom/bottom-sheet, swipe rows) need at the top of the tree.
 *
 * react-native-gesture-handler is a real dependency now, but we LAZY-require its
 * root view so a missing/native-only resolution can never break the Expo WEB
 * build at module load. If it resolves we use the real GestureHandlerRootView; if
 * not (or its require throws) we fall back to a plain flex:1 View — taps via RN
 * Pressable still work everywhere, gestures degrade gracefully.
 */
let GHRootView: React.ComponentType<{
  style?: unknown;
  children?: React.ReactNode;
}> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  GHRootView =
    require("react-native-gesture-handler").GestureHandlerRootView ?? null;
} catch {
  GHRootView = null;
}

export function GestureHandlerRootViewSafe({
  children,
}: {
  children: React.ReactNode;
}) {
  if (GHRootView)
    return <GHRootView style={styles.root}>{children}</GHRootView>;
  return <View style={styles.root}>{children}</View>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
