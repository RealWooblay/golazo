// GOLAZO — close ONE settled + drained market, reclaiming its SOL rent to the
// operator (the market authority). Wraps the program's `close_market`.
//
// Signed by the MARKET AUTHORITY (the operator that created it) — which is also
// the fee payer and the rent recipient — so run it with the operator keypair:
//
//   RPC_URL=https://api.mainnet-beta.solana.com \
//   WALLET=~/.config/solana/operator.json \
//   node scripts/close-market.mjs <marketAuthority> <marketSeed>
//
// The on-chain gate rejects any market that is not Resolved/Void OR whose vault
// still holds USX, so this can never strand user funds — a "wrong" target simply
// reverts in simulation (no fee).
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET = process.env.WALLET || `${process.env.HOME}/.config/solana/id.json`;

const disc = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

function loadWallet(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** Build the `close_market` instruction for a given market PDA + authority. */
export function closeMarketIx(market, authority) {
  const vault = pda([Buffer.from("vault"), market.toBuffer()]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true }, // authority (+ fee payer + rent recipient)
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: disc("close_market"),
  });
}

async function main() {
  const [authorityArg, seedArg] = process.argv.slice(2);
  if (!authorityArg || seedArg === undefined) {
    console.error("usage: node scripts/close-market.mjs <marketAuthority> <marketSeed>");
    process.exit(1);
  }
  const conn = new Connection(RPC, "confirmed");
  const wallet = loadWallet(WALLET);
  const marketAuthority = new PublicKey(authorityArg);
  const market = pda([
    Buffer.from("market"),
    marketAuthority.toBuffer(),
    u64(seedArg),
  ]);

  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(closeMarketIx(market, wallet.publicKey)),
    [wallet],
    { commitment: "confirmed" },
  );
  console.log(`closed market ${market.toBase58()} — tx ${sig}`);
}

// Only run when invoked directly (so close-all can import closeMarketIx).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
