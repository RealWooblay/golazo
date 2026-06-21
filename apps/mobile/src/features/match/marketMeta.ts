import { colors } from "@/theme";
import type { MarketSlot } from "@golazo/core";

/** Period markets get a violet accent (no semantic token for it in the theme). */
const VIOLET = "#a78bfa";

export interface Lane {
  label: string;
  color: string;
}

/** A hex colour at a given alpha — for lane-tinted borders/fills. */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * The lane a market belongs to — the small tag + accent colour on the card and the
 * locked strip. Derived from the engine `kind` (precise), falling back to the slot.
 */
export function laneOf(kind?: string, slot?: MarketSlot): Lane {
  const k = kind ?? "";
  if (k === "player_to_score") return { label: "Player", color: colors.gold };
  if (k === "shot_in_window" || k === "score_in_window")
    return { label: "Spell", color: colors.yes };
  if (k === "goal_in_stoppage") return { label: "Before half", color: VIOLET };
  if (k === "goal_in_extra_time") return { label: "Extra time", color: VIOLET };
  if (k === "penalty_scored") return { label: "Penalty", color: colors.cyan };
  if (k === "penalty_awarded" || k === "red_card_given")
    return { label: "VAR", color: colors.cyan };
  if (k.startsWith("goal_from")) return { label: "Set piece", color: colors.cyan };
  if (slot === "window") return { label: "Spell", color: colors.yes };
  if (slot === "player") return { label: "Player", color: colors.gold };
  if (slot === "period") return { label: "Before half", color: VIOLET };
  return { label: "Moment", color: colors.cyan };
}

/** The honest YES / NO verdict words — what the bet is actually ON, per market. */
export function betLabels(kind?: string, question?: string): { yes: string; no: string } {
  const k = kind ?? "";
  const q = (question ?? "").toLowerCase();
  if (k === "shot_in_window" || (/\bshot\b/.test(q) && !/goal/.test(q)))
    return { yes: "Shot", no: "No shot" };
  if (k === "player_to_score") return { yes: "Scores", no: "Doesn't" };
  if (k === "red_card_given" || /\bred card\b/.test(q)) return { yes: "Red", no: "No red" };
  if (k === "penalty_awarded" || (/\bpenalty\b/.test(q) && /awarded|var/.test(q)))
    return { yes: "Pen", no: "No pen" };
  if (
    k === "score_in_window" ||
    k === "penalty_scored" ||
    k.startsWith("goal_from") ||
    k.startsWith("goal_in") ||
    /\b(score|goal)\b/.test(q)
  )
    return { yes: "Goal", no: "No goal" };
  return { yes: "Yes", no: "No" };
}

/** Period markets resolve on the whistle, not a numeric timer — the card says so. */
export function isWhistleBound(kind?: string): boolean {
  return kind === "goal_in_stoppage" || kind === "goal_in_extra_time";
}

export function whistleLabel(kind?: string): string {
  return kind === "goal_in_extra_time" ? "until full-time" : "until half-time";
}
