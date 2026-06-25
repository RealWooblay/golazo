import React from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors, MAX_WIDTH, spacing, type } from "@/theme";
import { Text } from "@/ui";

/**
 * Carousel — a horizontal paged story for onboarding. Each page renders its
 * animated scene above a headline + sub. A parallax lift on the active page and
 * an animated progress-dot row sell the polish. Plain ScrollView paging keeps it
 * web-safe (no gesture-handler dependency for the swipe).
 */

export interface Slide {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  scene: React.ReactNode;
  accent: string;
}

export function Carousel({
  slides,
  index,
  onIndexChange,
  scrollRef,
}: {
  slides: Slide[];
  index: number;
  onIndexChange: (i: number) => void;
  scrollRef?: React.RefObject<ScrollView>;
}) {
  const { width: winWidth } = useWindowDimensions();
  const pageW = Math.min(winWidth, MAX_WIDTH);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / pageW);
    if (i !== index) onIndexChange(i);
  };

  return (
    <View style={[styles.wrap, { width: pageW, alignSelf: "center" }]}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
      >
        {slides.map((s, i) => (
          <Page key={s.key} slide={s} width={pageW} active={i === index} />
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {slides.map((s, i) => (
          <Dot
            key={s.key}
            active={i === index}
            color={colors.yes}
          />
        ))}
      </View>
    </View>
  );
}

function Page({
  slide,
  width,
  active,
}: {
  slide: Slide;
  width: number;
  active: boolean;
}) {
  const t = useSharedValue(active ? 1 : 0);
  React.useEffect(() => {
    t.value = withTiming(active ? 1 : 0, { duration: 320 });
  }, [active, t]);

  const sceneStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.4, 1]),
    transform: [
      { scale: interpolate(t.value, [0, 1], [0.92, 1]) },
      { translateY: interpolate(t.value, [0, 1], [10, 0]) },
    ],
  }));
  const textStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0, 1]),
    transform: [{ translateY: interpolate(t.value, [0, 1], [16, 0]) }],
  }));

  return (
    <View style={[styles.page, { width }]}>
      <Animated.View style={[styles.scene, sceneStyle]}>
        {slide.scene}
      </Animated.View>
      <Animated.View style={[styles.copy, textStyle]}>
        <Text style={[type.overline, { color: colors.textMuted }]}>
          {slide.eyebrow}
        </Text>
        <Text preset="hero" style={styles.title}>
          {slide.title}
        </Text>
        <Text preset="body" muted center style={styles.body}>
          {slide.body}
        </Text>
      </Animated.View>
    </View>
  );
}

function Dot({ active, color }: { active: boolean; color: string }) {
  const t = useSharedValue(active ? 1 : 0);
  React.useEffect(() => {
    t.value = withTiming(active ? 1 : 0, { duration: 240 });
  }, [active, t]);
  const style = useAnimatedStyle(() => ({
    width: interpolate(t.value, [0, 1], [7, 22]),
    backgroundColor: t.value > 0.5 ? color : colors.textGhost,
    opacity: interpolate(t.value, [0, 1], [0.5, 1]),
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.xl,
  },
  // flex:1 so the scene reserves + fills the space above the copy and centers the
  // hero. Without it the flex chain collapses this box to 0px and the hero (a
  // fixed-size SceneFrame) is clipped to nothing on mobile.
  scene: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  copy: { alignItems: "center", gap: spacing.sm },
  title: { color: colors.textPrimary, textAlign: "center" },
  body: { maxWidth: 320, marginTop: spacing.xs },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  dot: { height: 7, borderRadius: 4 },
});
