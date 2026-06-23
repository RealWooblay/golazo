// GOLAZO — sweep ONE market's operator rake (gross - net) to the treasury.
//
// Calls the deployed program's `sweep_rake` for a single market. Signed by the
// hardcoded WITHDRAW_AUTHORITY (the treasury), which is also the fee payer, so
// run it with that keypair:
//
//   RPC_URL=https://api.mainnet-beta.solana.com \
//   WALLET=~/.golazo/treasury.json \
//   node scripts/sweep-rake.mjs <marketAuthority> <marketSeed>
//
// The rake lands in the treasury's USX associated token account, which must
// already exist (see README / `spl-token create-account`).
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu");
const USX_MINT = new PublicKey("6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET = process.env.WALLET || `${process.env.HOME}/.config/solana/id.json`;

const disc = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const pda = (seeds, programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];
const ata = (owner) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USX_MINT.toBuffer()], ATA_PROGRAM);

function loadWallet(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** Build the `sweep_rake` instruction for a given market PDA. */
export function sweepRakeIx(market, treasury) {
  const vault = pda([Buffer.from("vault"), market.toBuffer()]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: treasury, isSigner: true, isWritable: true }, // withdraw_authority (+ fee payer)
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ata(treasury), isSigner: false, isWritable: true }, // treasury_token
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: disc("sweep_rake"),
  });
}

async function main() {
  const [authorityArg, seedArg] = process.argv.slice(2);
  if (!authorityArg || seedArg === undefined) {
    console.error("usage: node scripts/sweep-rake.mjs <marketAuthority> <marketSeed>");
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
    new Transaction().add(sweepRakeIx(market, wallet.publicKey)),
    [wallet],
    { commitment: "confirmed" },
  );
  console.log(`swept market ${market.toBase58()} — tx ${sig}`);
}

// Only run when invoked directly (so sweep-all can import sweepRakeIx).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
