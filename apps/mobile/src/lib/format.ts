/**
 * Tiny formatting helpers shared across the UI. Kept in one place so money and
 * odds always render identically (the prototype's `fmt` lived inline).
 */

/** "$1,000" — whole-dollar, thousands-separated. Mirrors index.html's fmt(). */
export function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** "+$240" / "−$25" — signed money for history + reveal payouts. */
export function signedMoney(n: number): string {
  // U+2212 minus sign (not hyphen) to match the prototype's typography.
  const sign = n >= 0 ? "+" : "−";
  return sign + money(Math.abs(n));
}

/** "3.48x" — a decimal odds multiple. */
export function multiple(x: number): string {
  return x.toFixed(2) + "x";
}

/** Percentage of the pool on YES, used for the split bar width. */
export function pct(part: number, whole: number): number {
  return whole > 0 ? (100 * part) / whole : 50;
}
