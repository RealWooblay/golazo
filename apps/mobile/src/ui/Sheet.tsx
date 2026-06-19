import React, { useCallback, useMemo, useRef } from "react";
import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius as radii, shadows, spacing, spring } from "@/theme";
import { Blur } from "./Blur";

/**
 * Sheet — a blurred bottom sheet for deposit/withdraw flows, the stake editor,
 * how-it-works, confirmations.
 *
 * On NATIVE it uses @gorhom/bottom-sheet (real drag-to-dismiss + snap points),
 * loaded lazily so a missing/native-only module can never break the Expo WEB
 * build. On WEB (and as a fallback) it renders a steady spring-up panel with a
 * blurred scrim — visually identical for screenshot verification, no gesture lib
 * dependency at module load.
 *
 * Controlled: `open` + `onClose`. Provide `snapPoints` (e.g. ['55%']) for native;
 * the web fallback ignores them and sizes to content.
 *
 * Note: expo-router can also present routes with `presentation: 'modal'`; use
 * this Sheet for IN-SCREEN sheets that overlay the current route.
 */
let GorhomSheet: typeof import("@gorhom/bottom-sheet") | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  GorhomSheet = require("@gorhom/bottom-sheet");
} catch {
  GorhomSheet = null;
}

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
  /** Native snap points (e.g. ['50%', '85%']). Default ['CONTENT_HEIGHT'] feel. */
  snapPoints?: (string | number)[];
  /** Show the drag-handle pill at the top (default true). */
  handle?: boolean;
  contentStyle?: ViewStyle;
}

export function Sheet(props: SheetProps) {
  const useNative = GorhomSheet && Platform.OS !== "web";
  return useNative ? <NativeSheet {...props} /> : <FallbackSheet {...props} />;
}

// ── Native (gorhom) ──────────────────────────────────────────────────────────
function NativeSheet({
  open,
  onClose,
  children,
  snapPoints,
  handle = true,
  contentStyle,
}: SheetProps) {
  const G = GorhomSheet!;
  const BottomSheetModal = G.BottomSheetModal;
  const BottomSheetBackdrop = G.BottomSheetBackdrop;
  const ref = useRef<import("@gorhom/bottom-sheet").BottomSheetModal>(null);
  const points = useMemo(() => snapPoints ?? ["60%"], [snapPoints]);

  React.useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (p: import("@gorhom/bottom-sheet").BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...p}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.6}
      />
    ),
    [BottomSheetBackdrop],
  );

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={points}
      onDismiss={onClose}
      enablePanDownToClose
      handleComponent={handle ? undefined : null}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.nativeBg}
      handleIndicatorStyle={styles.handleIndicator}
    >
      <View style={[styles.nativeContent, contentStyle]}>{children}</View>
    </BottomSheetModal>
  );
}

// ── Web / fallback (spring-up panel + blurred scrim) ─────────────────────────
function FallbackSheet({
  open,
  onClose,
  children,
  handle = true,
  contentStyle,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const progress = useSharedValue(0);

  React.useEffect(() => {
    progress.value = open
      ? withSpring(1, spring.entrance)
      : withTiming(0, { duration: 200 });
  }, [open, progress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * 420 }],
    opacity: progress.value > 0.05 ? 1 : 0,
  }));

  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
        <Blur intensity={20} tint="dark" style={StyleSheet.absoluteFill}>
          <View
            style={StyleSheet.absoluteFill}
            onStartShouldSetResponder={() => true}
            onResponderRelease={onClose}
          />
        </Blur>
      </Animated.View>

      <Animated.View
        style={[
          styles.fallbackPanel,
          { paddingBottom: insets.bottom + spacing.lg },
          panelStyle,
        ]}
      >
        {handle ? <View style={styles.handleIndicator} /> : null}
        <View style={[styles.fallbackContent, contentStyle]}>{children}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  nativeBg: {
    backgroundColor: colors.surface1,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
  },
  nativeContent: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  handleIndicator: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.hairline,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  fallbackPanel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface1,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderTopWidth: 1,
    borderColor: colors.hairline,
    ...shadows.lg,
  },
  fallbackContent: { paddingHorizontal: spacing.xl, paddingTop: spacing.xs },
});
