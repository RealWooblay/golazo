/**
 * UI PRIMITIVES — the GOLAZO component kit.
 *
 * Small, composable, premium building blocks every screen builds from. All are
 * web-safe (native-only modules are lazy-required behind a fallback), all share
 * the design tokens from '@/theme', and all interactive ones share the same
 * spring press-depth + haptic vocabulary.
 *
 *   import { Button, Card, Chip, AnimatedNumber } from '@/ui'
 *
 * Catalogue (see each file's header for full props):
 *   • Pressable      — the shared tappable (press-depth + haptic). Base of Button/Chip/etc.
 *   • Button         — primary | secondary | danger | ghost; sizes sm|md|lg; glow.
 *   • IconButton     — circular single-glyph tappable.
 *   • Surface / Card — layered gradient panel (+ hairline + top-highlight + shadow); Card adds padding/onPress.
 *   • Sheet          — blurred bottom sheet (gorhom native / spring fallback web).
 *   • Chip           — status pill (live pulse-dot) + selectable toggle.
 *   • AnimatedNumber — spring/timing count-to-value, tabular.
 *   • ProgressBar    — spring fill + shimmer; split-bar mode (YES/NO pool).
 *   • Shimmer        — sweeping highlight (over bars / skeletons).
 *   • Skeleton       — pulsing loading block (+ SkeletonGroup).
 *   • Toast          — transient top pill (tone + glow).
 *   • Banner         — inline persistent notice (tone-tinted).
 *   • Confetti       — lightweight reanimated win burst (trigger counter).
 *   • Divider        — hairline rule (+ optional label).
 *   • EmptyState     — thoughtful empty panel (icon + title + body + CTA).
 *   • Text           — type-preset convenience over RN Text.
 *   • GrainOverlay   — on-top noise (kills banding).
 *   • Vignette       — behind-content radial wash (focuses hero moments).
 *   • Blur           — frosted overlay (expo-blur native / translucent fallback).
 *   • haptics        — the tactile vocabulary wrapper (+ hapticIf).
 */

export { Pressable } from "./Pressable";
export type { PressableDepthProps } from "./Pressable";

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { IconButton } from "./IconButton";

export { Surface } from "./Surface";
export type { GlowKind } from "./Surface";
export { Card } from "./Card";

export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";

export { Chip } from "./Chip";
export type { ChipTone } from "./Chip";

export { AnimatedNumber } from "./AnimatedNumber";
export { ProgressBar } from "./ProgressBar";
export { Shimmer } from "./Shimmer";
export { Skeleton, SkeletonGroup } from "./Skeleton";

export { Toast } from "./Toast";
export type { ToastTone } from "./Toast";
export { Banner } from "./Banner";
export { Confetti } from "./Confetti";

export { Divider } from "./Divider";
export { EmptyState } from "./EmptyState";
export { Text } from "./Text";
export type { TextProps } from "./Text";

// Shared redesign kit — the minimal vocabulary every screen composes from.
export {
  withAlpha,
  LaneChip,
  Overline,
  MonoStat,
  StatCell,
  MiniBadge,
  IconPill,
  FlatRow,
} from "./kit";

export { GrainOverlay } from "./GrainOverlay";
export { Vignette } from "./Vignette";
export { Blur } from "./Blur";

export { Screen } from "./Screen";
export { StubScreen } from "./StubScreen";
export { TabBar } from "./TabBar";

export { haptics, hapticIf } from "./haptics";
export type { HapticName } from "./haptics";

// App-shell helpers (used by app/_layout + (tabs)/_layout).
export { GestureHandlerRootViewSafe } from "./GestureRoot";
export { BottomSheetProviderSafe } from "./BottomSheetProvider";
export { useAppFonts } from "./useAppFonts";

// Dependency-free icon set (24-grid, stroke).
export {
  IconPlay,
  IconWallet,
  IconProfile,
  IconBack,
  IconClose,
  IconPlus,
  IconArrowUp,
} from "./icons";
export type { IconProps } from "./icons";
