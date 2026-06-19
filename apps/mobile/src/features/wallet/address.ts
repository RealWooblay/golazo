/**
 * DEPOSIT ADDRESS — resolves *where* a crypto deposit should be sent.
 *
 * Contract with the chain feature (owned by another agent):
 *   When on-chain mode ships, `@/features/chain` is expected to export a hook
 *   `useChain()` returning at least `{ ready: boolean; address?: string }` (the
 *   user's embedded/connected Solana wallet pubkey). The wallet UI consumes that
 *   read-only — it never imports `@solana/web3.js` or any heavy/native lib, so
 *   importing a wallet screen can never pull the chain stack at module load.
 *
 * Until that hook exists (or in the default SANDBOX / play-money mode), we derive
 * a stable, valid-looking base58 Solana address from the local display name so
 * the QR + copy flows are demoable with zero backend. The sandbox address is
 * clearly labelled in the UI as a demo address.
 *
 * This module is pure + synchronous and safe to import anywhere.
 */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Tiny deterministic string hash (FNV-1a-ish) → unsigned 32-bit. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build a deterministic, base58-shaped pseudo-address (44 chars) from a seed.
 * It is NOT a real keypair — purely for sandbox demos of the deposit UI.
 */
export function sandboxAddress(seed: string): string {
  let state = hash32("golazo:" + (seed || "guest"));
  let out = "";
  // 44 chars is the canonical length of a Solana base58 pubkey.
  for (let i = 0; i < 44; i++) {
    // xorshift32 step for a deterministic but well-mixed stream.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    out += BASE58[state % BASE58.length];
  }
  return out;
}

/** Shorten an address for compact display: "7Xb3…9fQz". */
export function shortenAddress(addr: string, lead = 4, tail = 4): string {
  if (addr.length <= lead + tail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/**
 * Build a Solana Pay transfer URI for the QR code.
 * Spec: solana:<recipient>?amount=<sol>&label=<l>&message=<m>
 * (amount is in SOL; omit it for an open-ended "any amount" deposit.)
 */
export function solanaPayUri(opts: {
  recipient: string;
  amountSol?: number;
  label?: string;
  message?: string;
}): string {
  const params = new URLSearchParams();
  if (opts.amountSol && opts.amountSol > 0)
    params.set("amount", String(opts.amountSol));
  if (opts.label) params.set("label", opts.label);
  if (opts.message) params.set("message", opts.message);
  const qs = params.toString();
  return `solana:${opts.recipient}${qs ? `?${qs}` : ""}`;
}
