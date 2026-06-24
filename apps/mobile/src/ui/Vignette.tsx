import type { ViewStyle } from "react-native";

/**
 * Vignette — DEPRECATED no-op. The canvas is now FLAT: no radial background washes.
 * Accent + glow live surgically on live/active elements, never as a full-screen bloom
 * (that read as "AI slop"). Kept as a null-renderer so existing call sites compile.
 */
export function Vignette(_props: {
  tint?: "yes" | "no" | "gold" | "cyan" | "neutral";
  intensity?: number;
  cx?: number;
  cy?: number;
  r?: number;
  style?: ViewStyle;
}) {
  return null;
}
