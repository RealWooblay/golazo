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
import { SEEDS, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "./config";

const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);

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

/**
 * Derive the associated token account (ATA) address for (owner, mint).
 * ATA = findPDA([owner, TOKEN_PROGRAM, mint], ASSOCIATED_TOKEN_PROGRAM). This is
 * where a wallet holds its USX; the program reads/writes these on bet/claim.
 */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
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
