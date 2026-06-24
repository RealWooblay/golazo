import type { ViewStyle } from "react-native";

/**
 * GrainOverlay — DEPRECATED no-op. The canvas is now FLAT (no film-grain texture);
 * surfaces read as clean solid fills, the way the design direction calls for. Kept as
 * a null-renderer so existing call sites compile without edits.
 */
export function GrainOverlay(_props: {
  opacity?: number;
  density?: number;
  size?: number;
  style?: ViewStyle;
}) {
  return null;
}
