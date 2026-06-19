import React, { useEffect } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { colors, gradients, motion, radius, spacing, type } from "@/theme";
import { hapticIf } from "@/ui/haptics";

/**
 * FEATURE PRIMITIVES — the small, reusable building blocks the Lobby /
 * Onboarding / Profile screens share. These deliberately use ONLY the deps the
 * app already ships (react-native-svg for gradients/vignettes, reanimated for
 * motion) so the screens render on Expo Web with zero new packages. No
 * expo-linear-gradient / expo-blur — gradients are SVG, "blur" is a layered
 * translucent surface.
 */

// ── Pressable with spring depth + haptic ─────────────────────────────────────

export interface PressableScaleProps extends PressableProps {
  /** Press-down scale target. 'subtle' | 'normal' | 'deep' from theme. */
  depth?: keyof typeof motion.pressScale;
  /** Haptic to fire on press-in. Respects the store's haptics pref via prop. */
  haptic?: "tap" | "select" | "lock" | null;
  hapticsEnabled?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Every tappable in these screens uses this — a spring scale on press plus an
 * optional haptic. Feels tactile without a wrapper library.
 */
export function PressableScale({
  depth = "normal",
  haptic = "tap",
  hapticsEnabled,
  onPressIn,
  onPressOut,
  style,
  children,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(motion.pressScale[depth], motion.spring.press);
        if (haptic) hapticIf(hapticsEnabled, haptic);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, motion.spring.press);
        onPressOut?.(e);
      }}
      style={[animStyle, style as ViewStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}

export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// ── Surface card (layered depth + 1px top highlight) ─────────────────────────

export interface SurfaceProps {
  level?: 0 | 1 | 2 | 3;
  /** Adds the signature 1px top highlight hairline for real depth. */
  highlight?: boolean;
  glow?: "yes" | "no" | "cyan" | "gold" | "live" | null;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * The base card surface used everywhere. Layered fill + hairline border + an
 * inner top-edge highlight line, optionally a colored glow (live/active only).
 */
export function Surface({
  level = 1,
  highlight = true,
  glow = null,
  style,
  children,
}: SurfaceProps) {
  const glowStyle = glow ? glowShadow[glow] : null;
  return (
    <View
      style={[
        styles.surface,
        { backgroundColor: colors.surface[level] },
        glowStyle,
        style,
      ]}
    >
      {highlight ? (
        <View pointerEvents="none" style={styles.topHighlight} />
      ) : null}
      {children}
    </View>
  );
}

const glowShadow: Record<NonNullable<SurfaceProps["glow"]>, ViewStyle> = {
  yes: {
    shadowColor: colors.yes,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  no: {
    shadowColor: colors.no,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  cyan: {
    shadowColor: colors.cyan,
    shadowOpacity: 0.32,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
  },
  gold: {
    shadowColor: colors.gold,
    shadowOpacity: 0.4,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
  },
  live: {
    shadowColor: colors.yes,
    shadowOpacity: 0.28,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
  },
};

// ── Radial vignette (behind hero moments) ────────────────────────────────────

/**
 * A soft radial glow used behind hero content. Pure SVG so it works on web and
 * never intercepts taps.
 */
export function Vignette({
  color = colors.raw.surface2,
  opacity = 0.6,
  cx = "50%",
  cy = "38%",
  style,
}: {
  color?: string;
  opacity?: number;
  cx?: string;
  cy?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="golazoVignette" cx={cx} cy={cy} r="70%">
            <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#golazoVignette)" />
      </Svg>
    </View>
  );
}

// ── Linear gradient fill (SVG-backed, web-safe) ──────────────────────────────

let gradSeq = 0;

/**
 * An absolutely-filled SVG linear gradient — our stand-in for
 * expo-linear-gradient. Place as the first child of a rounded, overflow:hidden
 * container.
 */
export function GradientFill({
  colors: stops,
  start = { x: 0, y: 0 },
  end = { x: 0, y: 1 },
  style,
}: {
  colors: readonly string[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: StyleProp<ViewStyle>;
}) {
  const id = React.useMemo(() => `golazoGrad_${gradSeq++}`, []);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width="100%" height="100%">
        <Defs>
          <SvgLinearGradient
            id={id}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
          >
            {stops.map((c, i) => (
              <Stop
                key={i}
                offset={`${(i / Math.max(1, stops.length - 1)) * 100}%`}
                stopColor={c}
              />
            ))}
          </SvgLinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

// ── Status chip with live pulse dot ──────────────────────────────────────────

export function StatusChip({
  label,
  tone = "live",
  pulse = false,
  style,
}: {
  label: string;
  tone?: "live" | "cyan" | "gold" | "muted";
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const dotColor =
    tone === "live"
      ? colors.yes
      : tone === "cyan"
        ? colors.cyan
        : tone === "gold"
          ? colors.gold
          : colors.textFaint;
  const fill =
    tone === "live"
      ? colors.alpha.yes
      : tone === "cyan"
        ? colors.alpha.cyan
        : tone === "gold"
          ? colors.alpha.gold
          : colors.alpha.white06;
  const border =
    tone === "live"
      ? "rgba(0,229,138,0.4)"
      : tone === "cyan"
        ? "rgba(22,198,255,0.4)"
        : tone === "gold"
          ? "rgba(255,199,58,0.4)"
          : colors.hairline;

  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: fill, borderColor: border },
        style,
      ]}
    >
      {pulse ? (
        <PulseDot color={dotColor} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
      <Text style={[styles.chipText, { color: dotColor }]}>{label}</Text>
    </View>
  );
}

/** A pulsing dot — the live signal seen across the app. */
export function PulseDot({
  color = colors.yes,
  size = 7,
}: {
  color?: string;
  size?: number;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, {
        duration: motion.duration.dot,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => cancelAnimation(t);
  }, [t]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [0.5, 0]),
    transform: [{ scale: interpolate(t.value, [0, 1], [1, 2.6]) }],
  }));
  const coreStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 1], [1, 0.55]),
  }));
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
          haloStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
          },
          coreStyle,
        ]}
      />
    </View>
  );
}

// ── Animated count-up number (balance / stats) ───────────────────────────────

/**
 * A number that eases to its target value — the balance/stat ticker. Driven by
 * a self-cancelling rAF tween on the JS thread (web-safe, no worklet bridge),
 * so the digits visibly count up/down on every change. Tabular numerals in the
 * display face keep the width steady so it never jitters.
 */
export function CountUp({
  value,
  format,
  style,
  durationMs = motion.duration.slow,
}: {
  value: number;
  format: (n: number) => string;
  style?: StyleProp<TextStyle>;
  durationMs?: number;
}) {
  const [display, setDisplay] = React.useState(value);
  const fromRef = React.useRef(value);
  const rafRef = React.useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = Date.now();
    const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / durationMs);
      const v = from + (to - from) * easeOut(p);
      setDisplay(v);
      fromRef.current = v;
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    // Robustness: guarantee we land on the target even if requestAnimationFrame
    // is paused/throttled (a backgrounded or headless tab freezes rAF, which
    // would otherwise leave the number stuck at its pre-animation value).
    const settle = setTimeout(() => {
      fromRef.current = to;
      setDisplay(to);
    }, durationMs + 100);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearTimeout(settle);
    };
  }, [value, durationMs]);

  return <Text style={style}>{format(display)}</Text>;
}

// ── Shimmer skeleton block (loading) ─────────────────────────────────────────

export function Skeleton({
  width = "100%",
  height = 16,
  rounded = radius.sm,
  style,
}: {
  width?: number | `${number}%` | "auto";
  height?: number;
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, {
        duration: motion.duration.shimmer,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      false,
    );
    return () => cancelAnimation(t);
  }, [t]);
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [-160, 220]) }],
  }));
  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: rounded,
          backgroundColor: colors.surface2,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
        <GradientFill
          colors={gradients.shimmer}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ width: 160 }}
        />
      </Animated.View>
    </View>
  );
}

// ── A simple section header ──────────────────────────────────────────────────

export function SectionHeader({
  title,
  action,
  onAction,
  style,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.sectionHeader, style]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? (
        <PressableScale haptic="tap" onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

// ── Animated entrance wrapper (spring + fade + rise) ─────────────────────────

export function Entrance({
  delay = 0,
  children,
  style,
}: {
  delay?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withTiming(1, {
      duration: motion.duration.base,
      easing: Easing.out(Easing.cubic),
    });
    // small spring rise after the delay
    const id = setTimeout(() => {
      t.value = withSpring(1, motion.spring.entrance);
    }, delay);
    return () => clearTimeout(id);
  }, [t, delay]);
  const animStyle = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: interpolate(t.value, [0, 1], [14, 0]) }],
  }));
  return <Animated.View style={[animStyle, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  surface: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: "hidden",
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.topHighlight,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs + 1,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  chipText: { ...type.overline, fontSize: 10 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  sectionTitle: { ...type.subtitle, color: colors.textPrimary },
  sectionAction: { ...type.bodyStrong, color: colors.cyan, fontSize: 13 },
});
