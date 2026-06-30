/** Pull a human-readable message out of Privy / wallet-standard send failures. */
export function privyErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
    if (o.body && typeof o.body === "object") {
      const body = o.body as Record<string, unknown>;
      if (typeof body.error === "string") return body.error;
      if (typeof body.message === "string") return body.message;
    }
    if (typeof o.reason === "string") return o.reason;
    if (typeof o.code === "string") return o.code;
  }
  return "Transaction failed";
}

/** User-facing copy when sponsored gas fails before broadcast. */
export function sponsoredSendErrorMessage(e: unknown): string {
  const detail = privyErrorMessage(e);
  const lower = detail.toLowerCase();
  if (
    lower.includes("sponsor") ||
    lower.includes("gas") ||
    lower.includes("fee payer") ||
    lower.includes("insufficient")
  ) {
    return `Gas sponsorship failed: ${detail}`;
  }
  return `Gas sponsorship failed: ${detail}. Confirm Privy gas sponsorship is enabled for this app and has billing credits.`;
}
