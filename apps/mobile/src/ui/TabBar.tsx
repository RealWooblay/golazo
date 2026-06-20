import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import {
  colors,
  radius as radii,
  shadows,
  spacing,
  spring,
  type,
} from "@/theme";
import { Blur } from "./Blur";
import { Pressable } from "./Pressable";
import { IconPlay, IconProfile, IconRank, IconWallet, type IconProps } from "./icons";

/**
 * TabBar — the custom, blurred, floating bottom tab bar for the (tabs) group.
 *
 * Premium details: a frosted (expo-blur) capsule lifted off the bottom with a
 * soft shadow + hairline, each tab a Pressable with spring press-depth, the
 * ACTIVE tab lit with the brand accent + a soft glow pill behind its icon, and a
 * spring color/opacity crossfade on selection. Labels are uppercase overlines.
 *
 * Wired into expo-router via `tabBar={(p) => <TabBar {...p} />}` in (tabs)/_layout.
 * Each registered route maps to an icon + label below.
 */
const TABS: Record<
  string,
  { label: string; Icon: React.ComponentType<IconProps>; tint: string }
> = {
  index: { label: "Play", Icon: IconPlay, tint: colors.yes },
  rank: { label: "Rank", Icon: IconRank, tint: colors.gold },
  wallet: { label: "Wallet", Icon: IconWallet, tint: colors.cyan },
  profile: { label: "Profile", Icon: IconProfile, tint: colors.gold },
};

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.wrap,
        { paddingBottom: Math.max(insets.bottom, spacing.sm) },
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.shadow}>
        <Blur intensity={30} tint="dark" style={styles.bar}>
          {state.routes.map((route, index) => {
            const meta = TABS[route.name];
            if (!meta) return null;
            const focused = state.index === index;

            const onPress = () => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented)
                navigation.navigate(route.name);
            };

            return (
              <TabItem
                key={route.key}
                focused={focused}
                label={meta.label}
                Icon={meta.Icon}
                tint={meta.tint}
                onPress={onPress}
              />
            );
          })}
        </Blur>
      </View>
    </View>
  );
}

function TabItem({
  focused,
  label,
  Icon,
  tint,
  onPress,
}: {
  focused: boolean;
  label: string;
  Icon: React.ComponentType<IconProps>;
  tint: string;
  onPress: () => void;
}) {
  const f = useDerivedValue(
    () => withSpring(focused ? 1 : 0, spring.smooth),
    [focused],
  );

  const pillStyle = useAnimatedStyle(() => ({
    opacity: f.value,
    transform: [{ scale: 0.6 + f.value * 0.4 }],
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + f.value * 0.45,
  }));

  return (
    <Pressable onPress={onPress} haptic="tap" scaleTo={0.9} style={styles.item}>
      <View style={styles.iconWrap}>
        <Animated.View
          style={[
            styles.glowPill,
            { backgroundColor: tint, shadowColor: tint },
            pillStyle,
          ]}
          pointerEvents="none"
        />
        <Icon
          size={24}
          color={focused ? tint : colors.textMuted}
          strokeWidth={focused ? 2.3 : 2}
        />
      </View>
      <Animated.View style={labelStyle}>
        <Text
          style={[type.overline, { color: focused ? tint : colors.textMuted }]}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  shadow: {
    width: "100%",
    maxWidth: 420,
    borderRadius: radii.xl,
    ...shadows.lg,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.alpha.black60,
    overflow: "hidden",
  },
  item: { flex: 1, alignItems: "center", gap: 4, paddingVertical: spacing.xs },
  iconWrap: {
    width: 40,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  glowPill: {
    position: "absolute",
    width: 40,
    height: 26,
    borderRadius: 13,
    opacity: 0.16,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
});
