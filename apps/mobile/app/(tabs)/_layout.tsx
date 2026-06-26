import React from "react";
import { Stack, Redirect } from "expo-router";
import { useStore } from "@/state/store";

/**
 * APP STACK — there is NO tab bar. The app is one primary page (Play / Lobby) with
 * the Profile HUB pushed on top of it. Profile is reached via the profile icon in
 * the lobby header and dismissed with its back arrow; Wallet + Rank live INSIDE the
 * Profile hub (they are no longer separate destinations). Owned by FOUNDATION;
 * feature agents fill the route FILES, never this layout.
 *
 *   index   → Play / Lobby   (home agent)
 *   profile → Profile hub     (profile agent — merges wallet + rank + history)
 *
 * First-run redirect: if the persisted session has never completed onboarding we
 * push the onboarding flow once the store is hydrated.
 */
export default function AppStackLayout() {
  const { session, hydrated } = useStore();

  // First-run: redirect to onboarding DECLARATIVELY (imperative nav here can fire
  // before the root navigator mounts). <Redirect> is the safe pattern.
  if (hydrated && session.firstRun) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="profile" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
