import { Platform, type TextStyle } from "react-native";

/**
 * TYPOGRAPHY — the GOLAZO type system.
 *
 * Two families:
 *   • DISPLAY — Space Grotesk: a sporty grotesk used for odds, scores, balances,
 *     market questions. Has TABULAR numerals so animated tickers don't jitter.
 *   • BODY — Inter: clean sans for everything else (labels, copy, captions).
 *
 * Font NAMES below are the keys we pass to expo-font / @expo-google-fonts; the
 * root layout loads them and they resolve to these `fontFamily` strings. Until
 * fonts finish loading the system font is used (we hold the splash, so users
 * never see the swap).
 *
 * Use the `type` presets (display/title/body/caption/mono) as ready-made
 * TextStyle objects; reach for `family`/`size`/`weight` only for one-offs.
 */

// ── Font family names (must match the names registered in _layout.tsx) ───────
export const fontFamily = {
  display: "SpaceGrotesk_700Bold",
  displayMedium: "SpaceGrotesk_500Medium",
  displaySemiBold: "SpaceGrotesk_600SemiBold",
  body: "Inter_400Regular",
  bodyMedium: "Inter_500Medium",
  bodySemiBold: "Inter_600SemiBold",
  bodyBold: "Inter_700Bold",
  // Mono numerals for money/odds when we want fixed-width without the display face.
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  }),
} as const;

// ── Numeric size scale ───────────────────────────────────────────────────────
export const fontSize = {
  micro: 10,
  tiny: 11,
  caption: 12,
  small: 13,
  body: 15,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  display: 34,
  hero: 44,
  goal: 72, // GOOOAL flash
} as const;

// ── Weights (RN only honours these string literals reliably) ─────────────────
export const fontWeight = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  black: "900",
} as const satisfies Record<string, TextStyle["fontWeight"]>;

export const letterSpacing = {
  tighter: -0.6,
  tight: -0.3,
  normal: 0,
  wide: 0.4,
  wider: 0.8,
  widest: 1.4,
} as const;

const lineHeight = {
  tight: 1.1,
  snug: 1.2,
  normal: 1.4,
  relaxed: 1.55,
} as const;

/**
 * TABULAR NUMERALS — spread onto any <Text> that animates a number (balance,
 * odds, countdown) so digits keep a constant width and don't dance.
 */
export const tabularNumbers: TextStyle = {
  fontVariant: ["tabular-nums"],
};

/**
 * Ready-made text presets. Each is a complete TextStyle. Compose like:
 *   <Text style={[type.title, { color: colors.textPrimary }]}>…</Text>
 */
export const type = {
  /** Massive numerals — hero balances, big scorelines. Tabular. */
  hero: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.black,
    letterSpacing: letterSpacing.tight,
    lineHeight: fontSize.hero * lineHeight.tight,
    ...tabularNumbers,
  },
  /** Big display numbers — odds, balance value, score. Tabular. */
  display: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.display,
    fontWeight: fontWeight.bold,
    letterSpacing: letterSpacing.tight,
    lineHeight: fontSize.display * lineHeight.tight,
    ...tabularNumbers,
  },
  /** Section + market-question titles. */
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    letterSpacing: letterSpacing.tight,
    lineHeight: fontSize.xl * lineHeight.snug,
  },
  /** Sub-titles / prominent labels (team names, button labels). */
  subtitle: {
    fontFamily: fontFamily.displaySemiBold,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    letterSpacing: letterSpacing.normal,
    lineHeight: fontSize.lg * lineHeight.snug,
  },
  /** Default reading text. */
  body: {
    fontFamily: fontFamily.body,
    fontSize: fontSize.body,
    fontWeight: fontWeight.regular,
    letterSpacing: letterSpacing.normal,
    lineHeight: fontSize.body * lineHeight.relaxed,
  },
  /** Emphasised body. */
  bodyStrong: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    lineHeight: fontSize.body * lineHeight.normal,
  },
  /** Small supporting text. */
  caption: {
    fontFamily: fontFamily.body,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.regular,
    letterSpacing: letterSpacing.normal,
    lineHeight: fontSize.caption * lineHeight.normal,
  },
  /** Uppercase eyebrow / tag / overline. */
  overline: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: fontSize.tiny,
    fontWeight: fontWeight.bold,
    letterSpacing: letterSpacing.widest,
    textTransform: "uppercase",
  },
  /** Tabular display numbers at body size — money rows, odds chips. */
  mono: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    ...tabularNumbers,
  },
} as const satisfies Record<string, TextStyle>;

export type TypePreset = keyof typeof type;

// ── Legacy alias (the old `font.size` / `font.weight` shape) ─────────────────
export const font = {
  family: undefined,
  size: {
    micro: fontSize.micro,
    tiny: fontSize.tiny,
    small: fontSize.caption,
    body: fontSize.small,
    md: fontSize.md,
    lg: fontSize.lg,
    xl: fontSize.xl,
    xxl: fontSize.xl,
    huge: fontSize.xxl,
    goal: fontSize.goal,
  },
  weight: {
    regular: fontWeight.regular,
    semibold: fontWeight.bold,
    bold: fontWeight.bold,
    black: fontWeight.black,
  },
} as const;
