import "react-native-reanimated"; // must be imported once, before anything else
import "react-native-gesture-handler"; // side-effect: registers the gesture handler
import React, { useCallback, useEffect } from "react";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StoreProvider, useStore } from "@/state/store";
import { ChainProvider } from "@/features/chain/useChain";
import { FriendsRoomProvider } from "@/features/friends";
import { GestureHandlerRootViewSafe } from "@/ui/GestureRoot";
import { BottomSheetProviderSafe } from "@/ui/BottomSheetProvider";
import { useAppFonts } from "@/ui/useAppFonts";
import { colors } from "@/theme";

/**
 * ROOT LAYOUT — the provider stack + navigator for the whole app.
 *
 * Provider order (outermost → in):
 *   GestureHandlerRootView  → required at the tree root for gestures/bottom-sheet
 *     SafeAreaProvider      → notch / home-indicator insets everywhere
 *       StoreProvider       → the canonical persisted store (balance, session, …)
 *         BottomSheetModalProvider → lets any screen present a <Sheet>
 *
 * BOOT GATE: we hold the native splash until BOTH the fonts are loaded AND the
 * store has hydrated from AsyncStorage, so the first frame is fully themed with
 * the real balance — no font swap, no flash of default balance.
 *
 * NAVIGATION MAP (see STYLE_GUIDE.md):
 *   (tabs)              → bottom tab bar: Play / Wallet / Profile
 *   match/[id]          → live match screen (pushed from the lobby)
 *   onboarding          → first-run flow (pushed when session.firstRun)
 *   (modals)/deposit    → deposit sheet (modal presentation)
 *   (modals)/withdraw   → withdraw sheet (modal presentation)
 *   how-it-works        → explainer (modal presentation)
 */

// Keep the splash up until we explicitly hide it. Guarded — a double call or web
// no-op must never throw.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <GestureHandlerRootViewSafe>
      <SafeAreaProvider>
        <StoreProvider>
          {/* On-chain layer. Cheap to mount (lazy-loads web3 only on connect);
              autoConnect brings up the embedded wallet when chain mode is
              configured (EXPO_PUBLIC_CHAIN_ENABLED + a deployed program id). */}
          <ChainProvider autoConnect>
            <BottomSheetProviderSafe>
              <BootGate />
            </BottomSheetProviderSafe>
          </ChainProvider>
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootViewSafe>
  );
}

/** Holds the splash until fonts + store are ready, then renders the navigator. */
function BootGate() {
  const [fontsReady, fontError] = useAppFonts();
  const { hydrated } = useStore();
  const ready = (fontsReady || !!fontError) && hydrated;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  const onLayout = useCallback(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Render nothing (splash stays) until ready, so there's no themed-but-empty flash.
  if (!ready) return null;

  return (
    <FriendsRoomProvider>
      <View style={{ flex: 1, backgroundColor: colors.bg }} onLayout={onLayout}>
        <StatusBar style="light" />
        <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
          animationDuration: 240,
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="match/[id]" options={{ animation: "fade" }} />
        <Stack.Screen name="friends/index" />
        <Stack.Screen name="friends/[code]" options={{ animation: "fade" }} />
        <Stack.Screen name="join/[code]" />
        <Stack.Screen
          name="onboarding"
          options={{ animation: "fade", gestureEnabled: false }}
        />
        <Stack.Screen
          name="(modals)/deposit"
          options={{ presentation: "modal" }}
        />
        <Stack.Screen
          name="(modals)/withdraw"
          options={{ presentation: "modal" }}
        />
        <Stack.Screen name="how-it-works" options={{ presentation: "modal" }} />
        </Stack>
      </View>
    </FriendsRoomProvider>
  );
}
