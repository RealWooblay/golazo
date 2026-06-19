/**
 * COLOR TOKENS — the GOLAZO palette.
 *
 * Vibe: stadium-at-night. A near-black base with LAYERED surfaces (not flat
 * fills), neon accents used surgically with glow only on live/active states.
 *
 * Read this as three groups:
 *   1. raw      — the literal hex values (the brand palette).
 *   2. colors   — semantic tokens every component should reference (bg, surface,
 *                 textPrimary, yes, no, …). Prefer these over raw.
 *   3. gradients / glows — multi-stop sets + glow shadow colors for depth.
 *
 * Legacy aliases (accent, panel, txt, muted, faint, line…) are kept at the
 * bottom so the existing match components/screens keep compiling while feature
 * agents migrate to the semantic names.
 */

// ── 1. Raw brand palette ────────────────────────────────────────────────────
const raw = {
  // base / canvas
  black: "#0a0b0f",
  ink: "#06070a", // deepest — behind everything
  // layered surfaces, low → high elevation
  surface0: "#0e1016",
  surface1: "#13151d",
  surface2: "#1b1e29",
  surface3: "#232634",
  hairline: "#262a38",
  hairlineSoft: "#1d2130",

  // text
  white: "#f4f6fb",
  text: "#eef1f7",
  muted: "#8b93a7",
  faint: "#5a6276",
  ghost: "#3a4154",

  // accents
  lime: "#00e58a", // primary / YES / live
  limeBright: "#1fff9f", // gradient top / hover
  limeDeep: "#00d27e", // gradient bottom
  cyan: "#16c6ff", // secondary / info / selection
  cyanDeep: "#0a93d4",
  red: "#ff4d6d", // NO / danger
  redBright: "#ff6f88",
  redDeep: "#ff3358",
  gold: "#ffc73a", // wins / celebration / locked
  goldDeep: "#ffae00",

  // text-on-bright
  onLime: "#04110b",
  onGold: "#1a1300",
  onRed: "#2a0008",
} as const;

// ── 2. Semantic tokens (PREFER THESE) ───────────────────────────────────────
export const colors = {
  // canvas + elevation
  bg: raw.black,
  bgDeep: raw.ink,
  /** Indexable surface scale, surface[0] (lowest) → surface[3] (highest). */
  surface: [raw.surface0, raw.surface1, raw.surface2, raw.surface3] as const,
  // named convenience accessors for the common levels
  surface0: raw.surface0,
  surface1: raw.surface1,
  surface2: raw.surface2,
  surface3: raw.surface3,

  // borders / separators
  hairline: raw.hairline,
  hairlineSoft: raw.hairlineSoft,
  /** 1px top-edge highlight that gives cards real depth. */
  topHighlight: "rgba(255,255,255,0.06)",

  // text
  textPrimary: raw.text,
  textSecondary: raw.muted,
  textMuted: raw.muted,
  textFaint: raw.faint,
  textGhost: raw.ghost,

  // brand / semantic accents
  primary: raw.lime,
  secondary: raw.cyan,
  yes: raw.lime,
  no: raw.red,
  cyan: raw.cyan,
  gold: raw.gold,
  danger: raw.red,
  success: raw.lime,
  info: raw.cyan,
  warning: raw.gold,

  // text-on-accent
  onYes: raw.onLime,
  onPrimary: raw.onLime,
  onGold: raw.onGold,
  onNo: "#ffffff",

  // glow colors (use as shadowColor / for rgba halos)
  glow: {
    yes: "rgba(0,229,138,0.55)",
    yesSoft: "rgba(0,229,138,0.22)",
    no: "rgba(255,77,109,0.55)",
    noSoft: "rgba(255,77,109,0.22)",
    cyan: "rgba(22,198,255,0.5)",
    cyanSoft: "rgba(22,198,255,0.18)",
    gold: "rgba(255,199,58,0.6)",
    goldSoft: "rgba(255,199,58,0.22)",
    success: "rgba(0,229,138,0.5)",
    danger: "rgba(255,77,109,0.5)",
  },

  // translucent fills for chips / selected states
  alpha: {
    yes: "rgba(0,229,138,0.12)",
    no: "rgba(255,77,109,0.12)",
    cyan: "rgba(22,198,255,0.12)",
    gold: "rgba(255,199,58,0.12)",
    white06: "rgba(255,255,255,0.06)",
    white10: "rgba(255,255,255,0.10)",
    black40: "rgba(0,0,0,0.4)",
    black60: "rgba(0,0,0,0.6)",
  },

  // raw palette escape hatch (rarely needed)
  raw,

  // ── Legacy aliases (do not use in new code) ──
  appTop: raw.surface0,
  panel: raw.surface1,
  panel2: raw.surface2,
  line: raw.hairline,
  txt: raw.text,
  muted: raw.muted,
  faint: raw.faint,
  accent: raw.lime,
  accent2: raw.cyan,
  bgGradientTop: "#15212b",
  yesGradient: [raw.limeBright, raw.limeDeep] as const,
  noGradient: [raw.redBright, raw.redDeep] as const,
  onAccent: raw.onLime,
} as const;

// ── 3. Gradient stop sets ───────────────────────────────────────────────────
/** Each entry is an array of color stops for expo-linear-gradient `colors`. */
export const gradients = {
  /** App canvas: deep vertical wash, top slightly lifted. */
  canvas: [raw.surface0, raw.black, raw.ink] as const,
  /** Card body: top surface lifts to a darker base for depth. */
  card: [raw.surface2, raw.surface1] as const,
  cardElevated: [raw.surface3, raw.surface2] as const,
  /** YES button (top → bottom). */
  yes: [raw.limeBright, raw.limeDeep] as const,
  /** NO button (top → bottom). */
  no: [raw.redBright, raw.redDeep] as const,
  /** Gold celebration (wins, toast). */
  gold: [raw.gold, raw.goldDeep] as const,
  /** Brand wordmark sweep (lime → cyan). */
  brand: [raw.lime, raw.cyan] as const,
  /** Cyan info sweep. */
  cyan: [raw.cyan, raw.cyanDeep] as const,
  /** Countdown ring sweep — calm (lime → cyan). */
  ringCalm: [raw.lime, raw.cyan] as const,
  /** Countdown ring sweep — urgent (gold → red), last few seconds. */
  ringUrgent: [raw.gold, raw.redDeep] as const,
  /** Soft radial vignette stops (center → edge), used behind hero moments. */
  vignette: ["rgba(21,33,43,0.55)", "rgba(10,11,15,0)"] as const,
  /** Shimmer highlight for progress bars / skeletons. */
  shimmer: [
    "rgba(255,255,255,0)",
    "rgba(255,255,255,0.14)",
    "rgba(255,255,255,0)",
  ] as const,
} as const;

export type ColorName = keyof typeof colors;
export type GradientName = keyof typeof gradients;
