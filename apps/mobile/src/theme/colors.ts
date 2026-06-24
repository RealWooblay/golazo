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
  // base / canvas — flat, near-black (no full-screen wash)
  black: "#0B0C0F",
  ink: "#050608", // deepest — behind everything
  // layered surfaces, low → high elevation (solid fills, never gradients)
  surface0: "#121419", // faint
  surface1: "#15171C", // the standard card surface
  surface2: "#1E2128", // raised
  surface3: "#2D313A", // highest / strong divider
  hairline: "#23262D",
  hairlineSoft: "#1B1E24",

  // text
  white: "#FFFFFF",
  text: "#F5F7FA",
  muted: "#98A0AC",
  faint: "#565E6B",
  ghost: "#3A4150",

  // accents — ONE green accent, used surgically (live / primary / win)
  lime: "#27E08A", // primary / YES / live
  limeBright: "#3DEE9B", // gradient/hover top
  limeDeep: "#1FCB7B", // gradient bottom
  cyan: "#5B8DEF", // secondary / info / HOME team (calm blue, not neon)
  cyanDeep: "#3B6FD6",
  red: "#FF5267", // NO / danger
  redBright: "#FF6F82",
  redDeep: "#FF3D55",
  gold: "#FFB347", // wins / warning / locked
  goldDeep: "#F59E2E",
  // neutral team tints — contests read as A-vs-B, never right/wrong
  home: "#5B8DEF",
  away: "#F5A524",
  purple: "#C77DFF",

  // text-on-bright
  onLime: "#06231A",
  onGold: "#231300",
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
  /** Neutral team tints for contests (which-side markets) — A vs B, not right/wrong. */
  home: raw.home,
  away: raw.away,
  purple: raw.purple,

  // text-on-accent
  onYes: raw.onLime,
  onPrimary: raw.onLime,
  onGold: raw.onGold,
  onNo: "#ffffff",

  // glow colors (use as shadowColor / for rgba halos) — kept subtle; halos read as a
  // faint edge, never a full bloom. Accent + glow live on LIVE/active state only.
  glow: {
    yes: "rgba(39,224,138,0.30)",
    yesSoft: "rgba(39,224,138,0.12)",
    no: "rgba(255,82,103,0.28)",
    noSoft: "rgba(255,82,103,0.10)",
    cyan: "rgba(91,141,239,0.26)",
    cyanSoft: "rgba(91,141,239,0.10)",
    gold: "rgba(255,179,71,0.28)",
    goldSoft: "rgba(255,179,71,0.10)",
    success: "rgba(39,224,138,0.28)",
    danger: "rgba(255,82,103,0.26)",
  },

  // translucent fills for chips / selected states
  alpha: {
    yes: "rgba(39,224,138,0.12)",
    no: "rgba(255,82,103,0.12)",
    cyan: "rgba(91,141,239,0.13)",
    gold: "rgba(255,179,71,0.12)",
    home: "rgba(91,141,239,0.13)",
    away: "rgba(245,165,36,0.13)",
    purple: "rgba(199,125,255,0.13)",
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
  /** App canvas: flat near-black (no vertical wash — keep the canvas calm). */
  canvas: [raw.black, raw.black, raw.black] as const,
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
  /** Soft radial vignette stops (center → edge). Near-invisible — the canvas stays flat;
   *  any hero tint is applied surgically per-component, not as a full-screen wash. */
  vignette: ["rgba(255,255,255,0.015)", "rgba(10,11,15,0)"] as const,
  /** Shimmer highlight for progress bars / skeletons. */
  shimmer: [
    "rgba(255,255,255,0)",
    "rgba(255,255,255,0.14)",
    "rgba(255,255,255,0)",
  ] as const,
} as const;

export type ColorName = keyof typeof colors;
export type GradientName = keyof typeof gradients;
