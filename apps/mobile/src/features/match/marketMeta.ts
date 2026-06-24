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
export function laneOf(kind?: string, slot?: MarketSlot, question?: string): Lane {
  const k = kind ?? "";
  if (k === "player_to_score") return { label: "Player", color: colors.gold };
  if (k === "shot_in_window" || k === "score_in_window" || k === "shot_or_corner_in_window")
    return { label: "Spell", color: colors.yes };
  // Teamless either-team "event" lane (a booking / a goal in the next few minutes).
  if (k === "card_in_window") return { label: "Booking", color: colors.cyan };
  if (k === "goal_in_window") return { label: "Either team", color: colors.yes };
  // Over/under "count" lane (more than N corners / shots).
  if (k === "over_corners" || k === "over_shots") return { label: "Over/Under", color: colors.gold };
  // Which-side-next CONTEST lane (next shot/corner/goal/card — which team?).
  if (k === "next_shot" || k === "next_corner" || k === "next_goal" || k === "next_card")
    return { label: "Next", color: colors.cyan };
  if (k === "goal_in_stoppage")
    return { label: isFullTimeStoppage(question) ? "Before FT" : "Before half", color: VIOLET };
  if (k === "goal_in_extra_time") return { label: "Extra time", color: VIOLET };
  if (k === "penalty_scored") return { label: "Penalty", color: colors.cyan };
  if (k === "penalty_awarded" || k === "red_card_given")
    return { label: "VAR", color: colors.cyan };
  if (k.startsWith("goal_from")) return { label: "Set piece", color: colors.cyan };
  if (slot === "window") return { label: "Spell", color: colors.yes };
  if (slot === "player") return { label: "Player", color: colors.gold };
  if (slot === "period") return { label: "Before half", color: VIOLET };
  if (slot === "event") return { label: "Either team", color: colors.yes };
  if (slot === "count") return { label: "Over/Under", color: colors.gold };
  if (slot === "versus") return { label: "Next", color: colors.cyan };
  return { label: "Moment", color: colors.cyan };
}

/** Parse "Next shot: Jordan or Algeria?" (or the old "— Jordan or Algeria?") into team names. */
export function versusLabelsFromQuestion(
  question?: string,
): { yes: string; no: string } | null {
  const m = (question ?? "").match(/[—:]\s*(.+?)\s+or\s+(.+?)\?\s*$/i);
  if (!m) return null;
  return { yes: m[1]!.trim(), no: m[2]!.trim() };
}

/** Human label for the side you picked (team name on versus markets, not raw YES/NO). */
export function sideDisplayLabel(
  side: "YES" | "NO",
  kind?: string,
  question?: string,
): string {
  const labels = betLabels(kind, question);
  return side === "YES" ? labels.yes : labels.no;
}

/** Outcome badge copy — winning team name on versus markets. */
export function outcomeDisplayLabel(
  outcome: "YES" | "NO" | "VOID",
  kind?: string,
  question?: string,
): string {
  if (outcome === "VOID") return "VOID";
  return sideDisplayLabel(outcome, kind, question);
}

/**
 * True for the "who's next — A or B?" contest markets (the only family whose answer is a
 * TEAM). Gated on KIND, never on parsing "or" out of the question — otherwise a window market
 * worded "a SHOT or CORNER …?" gets mis-read as a team-vs-team contest (wrong labels + a
 * bogus "until next threat" on a timer market).
 */
export function isVersusKind(kind?: string): boolean {
  return (
    kind === "next_shot" ||
    kind === "next_corner" ||
    kind === "next_goal" ||
    kind === "next_card"
  );
}

/**
 * Clean SETTLED verdict for the result badge. Versus/"who next" markets show the winning
 * TEAM; everything else collapses to a plain YES / NO / VOID — never the event-verb labels.
 */
export function resultBadgeLabel(
  outcome: "YES" | "NO" | "VOID",
  kind?: string,
  question?: string,
): string {
  if (outcome === "VOID") return "VOID";
  if (isVersusKind(kind)) {
    const versus = versusLabelsFromQuestion(question);
    if (versus) return outcome === "YES" ? versus.yes : versus.no; // the winning team
  }
  return outcome; // "YES" / "NO"
}

/** The honest YES / NO verdict words — what the bet is actually ON, per market. */
export function betLabels(kind?: string, question?: string): { yes: string; no: string } {
  const k = kind ?? "";
  const q = (question ?? "").toLowerCase();
  // Which-side-next contest — "Next shot — A or B?": the two team names ARE the buttons.
  // Gated on KIND so a window market worded "a SHOT or CORNER …?" isn't parsed as versus.
  if (isVersusKind(k)) {
    return versusLabelsFromQuestion(question) ?? { yes: "Yes", no: "No" };
  }
  // Over/under count markets — the honest verdict is over/under the line.
  if (k === "over_corners" || k === "over_shots") return { yes: "Over", no: "Under" };
  // "A shot OR corner …?" is a plain yes/no question (what if BOTH happen?) — not a choice
  // between the two — so the buttons are YES / NO, not "Shot/corner".
  if (k === "shot_or_corner_in_window") return { yes: "Yes", no: "No" };
  // "A booking in the next few minutes?" — a card is the YES.
  if (k === "card_in_window") return { yes: "Card", no: "No card" };
  // "A goal in the next few minutes? (either team)" — a goal is the YES.
  if (k === "goal_in_window") return { yes: "Goal", no: "No goal" };
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

/**
 * Versus / next-side markets resolve on the first decisive event, not a deadline timer.
 * Gated on KIND only — a window market ("a SHOT or CORNER …?") is timer-settled and must
 * NOT show "until next threat" (the bug where a timer + "until next threat" appeared together).
 */
export function isEventDecided(kind?: string): boolean {
  return isVersusKind(kind);
}

/** A 2nd-half stoppage market reads "…before full-time?"; a 1st-half one "…before half-time?". */
function isFullTimeStoppage(question?: string): boolean {
  return /full[- ]?time|\bFT\b|final whistle/i.test(question ?? "");
}

export function whistleLabel(kind?: string, question?: string): string {
  if (kind === "goal_in_extra_time") return "until full-time";
  // goal_in_stoppage covers BOTH halves — the boundary is in the question, not the kind.
  if (isFullTimeStoppage(question)) return "until full-time";
  return "until half-time";
}

export function eventDecidedLabel(kind?: string): string {
  if (kind === "next_corner") return "until next corner";
  if (kind === "next_goal") return "until next goal";
  if (kind === "next_card") return "until next booking";
  return "until next threat";
}
