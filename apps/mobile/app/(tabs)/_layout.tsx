import React from "react";
import { Tabs, Redirect } from "expo-router";
import { useStore } from "@/state/store";
import { TabBar } from "@/ui/TabBar";

/**
 * TAB LAYOUT — the three primary destinations, with the custom blurred floating
 * tab bar ({@link TabBar}). Owned by FOUNDATION; feature agents fill the route
 * FILES, never this layout.
 *
 *   index   → Play / Lobby  (home agent)
 *   wallet  → Wallet         (wallet agent)
 *   profile → Profile        (profile agent)
 *
 * First-run redirect: if the persisted session has never completed onboarding we
 * push the onboarding flow once the store is hydrated (the root BootGate already
 * waited for hydration, so `session` is real here).
 */
export default function TabsLayout() {
  const { session, hydrated } = useStore();

  // First-run: redirect to onboarding DECLARATIVELY. Navigating imperatively in a
  // useEffect here can fire before the root navigator has mounted ("Attempted to
  // navigate before mounting the Root Layout"); <Redirect> is the safe pattern.
  if (hydrated && session.firstRun) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Tabs
      screenOptions={{ headerShown: false, lazy: true }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="index" options={{ title: "Play" }} />
      <Tabs.Screen name="rank" options={{ title: "Rank" }} />
      <Tabs.Screen name="wallet" options={{ title: "Wallet" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
