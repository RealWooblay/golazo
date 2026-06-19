import { Platform, type ViewStyle } from "react-native";
import { colors } from "./colors";

/**
 * SHADOWS — soft, large-radius elevations + colored glows for live/active state.
 *
 * Each preset is a ViewStyle you can spread directly. We set both iOS
 * (shadowColor/Offset/Opacity/Radius) and Android (elevation); on web RN
 * translates shadow* to boxShadow, so these are web-safe too.
 *
 * GLOWS are the signature touch — a colored halo on live markets, the active
 * YES/NO buttons, and win moments. Use them surgically (the brief says: glow on
 * live/active states ONLY), never as ambient decoration.
 */

type Shadow = Pick<
  ViewStyle,
  | "shadowColor"
  | "shadowOffset"
  | "shadowOpacity"
  | "shadowRadius"
  | "elevation"
>;

const soft = (
  color: string,
  opacity: number,
  radius: number,
  y: number,
  elevation: number,
): Shadow => ({
  shadowColor: color,
  shadowOffset: { width: 0, height: y },
  shadowOpacity: opacity,
  shadowRadius: radius,
  elevation: Platform.OS === "android" ? elevation : 0,
});

export const shadows = {
  none: soft("#000", 0, 0, 0, 0),
  /** Subtle lift for chips / small surfaces. */
  sm: soft("#000", 0.3, 8, 4, 3),
  /** Default card shadow (matches prototype's 0 12px 40px rgba(0,0,0,.5)). */
  md: soft("#000", 0.45, 24, 12, 8),
  /** Deep — sheets, hero panels, floating tab bar. */
  lg: soft("#000", 0.55, 40, 18, 16),

  // ── Colored glows (active/live only) ──
  glowYes: soft(colors.yes, 0.55, 20, 0, 12),
  glowNo: soft(colors.no, 0.55, 20, 0, 12),
  glowCyan: soft(colors.cyan, 0.5, 18, 0, 10),
  glowGold: soft(colors.gold, 0.6, 22, 0, 14),
  /** Live-market ambient halo (softer than the button glows). */
  glowLive: soft(colors.yes, 0.35, 28, 0, 10),
} as const;

export type ShadowName = keyof typeof shadows;
