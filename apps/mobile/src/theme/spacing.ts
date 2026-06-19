/**
 * SPACING + RADII — one consistent scale so every component aligns.
 *
 * Spacing follows a soft 4pt grid. Reach for the named steps (xs…xxxl) rather
 * than literals so vertical rhythm stays even across screens.
 */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/** Border radii. Cards are large-radius for the premium, soft-cornered look. */
export const radius = {
  xs: 8,
  sm: 11, // chips / pills / small rows
  md: 14, // buttons / scoreboard
  lg: 18, // cards (matches prototype --r)
  xl: 24, // sheets / hero panels
  xxl: 32,
  pill: 999,
} as const;

/** Hairline border width — 1px (or sub-pixel on dense displays via StyleSheet). */
export const hairlineWidth = 1;

/** Standard touch target floor (accessibility). */
export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/** Max content width — caps the "app" column at iPhone width on web/tablet. */
export const MAX_WIDTH = 480;

export type SpacingKey = keyof typeof spacing;
export type RadiusKey = keyof typeof radius;
