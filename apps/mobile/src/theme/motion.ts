import { Easing } from "react-native-reanimated";

/**
 * MOTION — spring presets, durations and easings for a tactile, fast UI.
 *
 * The whole product lives or dies on micro-motion: pressable depth, number
 * tickers, the countdown ring, the reveal flip, the win burst. Centralising the
 * physics here keeps every animation feeling like it came from the same hand.
 *
 * Usage (reanimated):
 *   withSpring(target, motion.spring.press)
 *   withTiming(target, { duration: motion.duration.fast, easing: motion.easing.out })
 */

/** Spring configs for `withSpring`. Tuned for snappy-but-weighty feel. */
export const spring = {
  /** Press-down / release on buttons + chips. Quick, minimal overshoot. */
  press: { damping: 18, stiffness: 320, mass: 0.6 },
  /** Card / sheet entrances. A little bounce for life. */
  entrance: { damping: 16, stiffness: 180, mass: 0.9 },
  /** Bouncy — toast drop-in, win pop, badge. */
  bouncy: { damping: 11, stiffness: 200, mass: 0.8 },
  /** Smooth, no overshoot — number tickers, odds, balance counts. */
  smooth: { damping: 26, stiffness: 150, mass: 1 },
  /** Stiff & immediate — split bar, progress. */
  snappy: { damping: 22, stiffness: 400, mass: 0.5 },
  /** Heavy — the reveal-card flip. */
  weighty: { damping: 14, stiffness: 120, mass: 1.2 },
} as const;

/** Durations (ms) for `withTiming` / delays. */
export const duration = {
  instant: 90,
  fast: 160,
  base: 240,
  slow: 360,
  slower: 520,
  /** Countdown urgency pulse cadence in the last 3s. */
  pulse: 600,
  /** Live status dot pulse. */
  dot: 1200,
  /** Shimmer sweep loop. */
  shimmer: 1400,
} as const;

/** Easing curves. */
export const easing = {
  out: Easing.out(Easing.cubic),
  in: Easing.in(Easing.cubic),
  inOut: Easing.inOut(Easing.cubic),
  /** Springy cubic-bezier matching the prototype toast (.2,1.4,.4,1). */
  overshoot: Easing.bezier(0.2, 1.4, 0.4, 1),
  linear: Easing.linear,
} as const;

/** Press feedback scale targets (shared by Button / IconButton / Chip). */
export const pressScale = {
  subtle: 0.98,
  normal: 0.96,
  deep: 0.94,
} as const;

export const motion = { spring, duration, easing, pressScale } as const;

export type SpringName = keyof typeof spring;
