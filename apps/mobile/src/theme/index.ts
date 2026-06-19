/**
 * THEME BARREL — the single import surface for the GOLAZO design system.
 *
 *   import { theme } from '@/theme'              // the whole object
 *   import { colors, type, spacing } from '@/theme'  // individual tokens
 *
 * Everything a screen needs to look on-brand is here: colors + gradients +
 * glows, the type system, spacing/radii, shadows, and motion presets.
 */

export { colors, gradients } from "./colors";
export type { ColorName, GradientName } from "./colors";

export {
  font,
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  tabularNumbers,
  type,
} from "./typography";
export type { TypePreset } from "./typography";

export { spacing, radius, hairlineWidth, hitSlop, MAX_WIDTH } from "./spacing";
export type { SpacingKey, RadiusKey } from "./spacing";

export { shadows } from "./shadows";
export type { ShadowName } from "./shadows";

export { motion, spring, duration, easing, pressScale } from "./motion";
export type { SpringName } from "./motion";

import { colors, gradients } from "./colors";
import {
  type as typePresets,
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  tabularNumbers,
} from "./typography";
import { spacing, radius, hairlineWidth, hitSlop, MAX_WIDTH } from "./spacing";
import { shadows } from "./shadows";
import { motion } from "./motion";

/** The canonical theme object — one stop for everything. */
export const theme = {
  colors,
  gradients,
  type: typePresets,
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  tabularNumbers,
  spacing,
  radius,
  hairlineWidth,
  hitSlop,
  shadows,
  motion,
  layout: { maxWidth: MAX_WIDTH },
} as const;

export type Theme = typeof theme;
