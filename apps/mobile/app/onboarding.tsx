// OWNED BY: home agent (first-run onboarding).
//
// Shown once on first run ((tabs)/_layout redirects here while session.firstRun).
// A short, gorgeous story that sells the hook — "bet the play, get paid in
// seconds" — then a frictionless finish: an optional handle, a starter play-money
// stack, and a "Start playing" CTA that saves the name, clears firstRun, and
// drops the player straight into the lobby. Fully skippable; the loop is the
// product. Web-safe (SVG/reanimated only, ScrollView paging — no new deps).
import React, { useRef, useState } from "react";
import {
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useStore } from "@/state/store";
import { POINTS_START_BALANCE } from "@golazo/core";
import { colors, MAX_WIDTH, spacing } from "@/theme";
import { Button, GrainOverlay, Text, Vignette } from "@/ui";
import { haptics } from "@/ui/haptics";
import { PressableScale } from "@/features/_shared/primitives";
import { UnifiedHeader } from "@/features/_shared/UnifiedHeader";
import {
  Carousel,
  SceneInstantPay,
  SceneLiveSlate,
  SceneMarketPop,
  StartPanel,
  type Slide,
} from "@/features/onboarding";

const SLIDES: Slide[] = [
  {
    key: "play",
    eyebrow: "WHILE THE MATCH IS LIVE",
    title: "Bet the play.",
    body: "A moment kicks off and a short YES/NO market pops. Tap a side and see the live estimated payout.",
    scene: <SceneMarketPop />,
    accent: colors.yes,
  },
  {
    key: "paid",
    eyebrow: "NO WAITING AROUND",
    title: "Get paid in seconds.",
    body: "The play resolves, the market settles, and a win pays out your share of the final pool.",
    scene: <SceneInstantPay />,
    accent: colors.gold,
  },
  {
    key: "slate",
    eyebrow: "LIVE MATCH SLATE",
    title: "Pick a fixture.",
    body: "Open a live match and take the markets as they appear.",
    scene: <SceneLiveSlate />,
    accent: colors.cyan,
  },
];

export default function Onboarding() {
  const router = useRouter();
  const store = useStore();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const [index, setIndex] = useState(0);
  const [name, setName] = useState(store.session.displayName ?? "");
  const isLast = index === SLIDES.length - 1;
  const hx = store.session.hapticsOn;

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, i));
    setIndex(clamped);
    // Page width = the actual on-screen width (capped at the app column on web),
    // so the programmatic scroll lands exactly on the page paging snaps to.
    const pageW = Math.min(Dimensions.get("window").width, MAX_WIDTH);
    scrollRef.current?.scrollTo({ x: clamped * pageW, animated: true });
  };

  const next = () => {
    if (hx) haptics.tap();
    if (isLast) return;
    goTo(index + 1);
  };

  const finish = () => {
    if (hx) haptics.win();
    const trimmed = name.trim();
    if (trimmed) store.setName(trimmed);
    store.setMoneyMode("points");
    store.completeFirstRun();
    router.replace("/(tabs)");
  };

  const skip = () => {
    if (hx) haptics.selection();
    finish();
  };

  return (
    <View style={styles.root}>
      <Vignette
        tint={
          SLIDES[index]?.accent === colors.gold
            ? "gold"
            : SLIDES[index]?.accent === colors.cyan
              ? "cyan"
              : "yes"
        }
        intensity={0.5}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* top bar: GOLAZO wordmark + Skip — unified 'tab' header (caller owns the
            safe-area top inset). */}
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.column}>
            <UnifiedHeader
              variant="tab"
              right={
                !isLast ? (
                  <PressableScale
                    haptic="tap"
                    hapticsEnabled={hx}
                    onPress={skip}
                    hitSlop={10}
                  >
                    <Text preset="bodyStrong" muted>
                      Skip
                    </Text>
                  </PressableScale>
                ) : undefined
              }
            />
          </View>
        </View>

        {/* story */}
        <View style={styles.flex}>
          <Carousel
            slides={SLIDES}
            index={index}
            onIndexChange={setIndex}
            scrollRef={scrollRef}
          />
        </View>

        {/* bottom action area */}
        <View
          style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}
        >
          <View style={styles.column}>
            <View style={styles.footerInner}>
              {isLast ? (
                <StartPanel
                  name={name}
                  onChangeName={setName}
                  onStart={finish}
                />
              ) : (
                <View style={styles.advance}>
                  <Button
                    label="Continue"
                    onPress={next}
                    variant="primary"
                    size="lg"
                    fullWidth
                    flat
                    haptic="tap"
                  />
                  <PressableScale
                    haptic="tap"
                    hapticsEnabled={hx}
                    onPress={finish}
                    style={styles.jumpIn}
                  >
                    <Text preset="caption" faint center>
                      Or jump straight in →
                    </Text>
                  </PressableScale>
                </View>
              )}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <GrainOverlay opacity={0.04} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  column: { width: "100%", maxWidth: MAX_WIDTH, alignSelf: "center" },
  topBar: { paddingHorizontal: spacing.lg },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  footerInner: {},
  advance: { gap: spacing.md },
  jumpIn: { paddingVertical: spacing.xs, alignSelf: "center" },
});
