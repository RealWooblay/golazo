/**
 * PDA DERIVATION — the client mirror of the program's `seeds = [...]` constraints.
 *
 * These MUST agree byte-for-byte with `instructions::seeds` and every
 * `#[account(seeds = [...])]` in the program:
 *   market : ["market", authority, market_seed_le_u64]
 *   vault  : ["vault",  market]
 *   bet    : ["bet",    market, bettor]
 *
 * The `market_seed` is encoded as a little-endian u64 — matching the Rust
 * `&market_seed.to_le_bytes()`. Getting endianness wrong silently derives the
 * wrong address, so this is centralized and documented.
 *
 * Imports web3 (PublicKey) — reached only via the lazy chain path.
 */

import { PublicKey } from "@solana/web3.js";
import { SEEDS } from "./config";

/** market_seed (u64) → 8-byte little-endian buffer, matching `to_le_bytes()`. */
function u64ToLeBytes(value: bigint | number): Uint8Array {
  const v = BigInt(value);
  const out = new Uint8Array(8);
  let n = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Derive the market PDA for (authority, marketSeed). */
export function deriveMarketPda(
  programId: PublicKey,
  authority: PublicKey,
  marketSeed: bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.MARKET), authority.toBuffer(), u64ToLeBytes(marketSeed)],
    programId,
  );
}

/** Derive the vault PDA for a market. */
export function deriveVaultPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.VAULT), market.toBuffer()],
    programId,
  );
}

/** Derive the per-(market, bettor) bet PDA. */
export function deriveBetPda(
  programId: PublicKey,
  market: PublicKey,
  bettor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.BET), market.toBuffer(), bettor.toBuffer()],
    programId,
  );
}

/** Convenience: derive market + vault (+ bet, if a bettor is given) at once. */
export function deriveAllPdas(
  programId: PublicKey,
  authority: PublicKey,
  marketSeed: bigint | number,
  bettor?: PublicKey,
): { market: PublicKey; vault: PublicKey; bet?: PublicKey } {
  const [market] = deriveMarketPda(programId, authority, marketSeed);
  const [vault] = deriveVaultPda(programId, market);
  const bet = bettor ? deriveBetPda(programId, market, bettor)[0] : undefined;
  return { market, vault, bet };
}
