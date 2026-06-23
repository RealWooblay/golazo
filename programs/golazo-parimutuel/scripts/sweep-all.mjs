// GOLAZO — sweep EVERY resolved-but-unswept market's rake to the treasury.
//
// Scans all Market accounts, keeps the ones that are Resolved and not yet
// swept, and sweeps each (one tx per market). Idempotent: re-running only
// touches markets that still have rake to collect.
//
//   RPC_URL=https://api.mainnet-beta.solana.com \
//   WALLET=~/.golazo/treasury.json \
//   node scripts/sweep-all.mjs
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { sweepRakeIx } from "./sweep-rake.mjs";

const PROGRAM_ID = new PublicKey("GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu");
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET = process.env.WALLET || `${process.env.HOME}/.config/solana/id.json`;

// Market account layout (see state.rs). Total size = 119 bytes incl. 8-byte disc.
const MARKET_SIZE = 119;
const OFF_STATUS = 82; // 0=Open 1=Locked 2=Resolved 3=Void
const OFF_RAKE_SWEPT = 118;
const STATUS_RESOLVED = 2;

function loadWallet(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const wallet = loadWallet(WALLET);

  // dataSize filter keeps the RPC from returning Bet/other accounts.
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: MARKET_SIZE }],
  });

  const pending = accounts.filter(
    ({ account }) =>
      account.data[OFF_STATUS] === STATUS_RESOLVED &&
      account.data[OFF_RAKE_SWEPT] === 0,
  );

  console.log(
    `${accounts.length} markets, ${pending.length} resolved + unswept`,
  );

  for (const { pubkey: market } of pending) {
    try {
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction().add(sweepRakeIx(market, wallet.publicKey)),
        [wallet],
        { commitment: "confirmed" },
      );
      console.log(`  swept ${market.toBase58()} — ${sig}`);
    } catch (e) {
      // Don't let one market (e.g. zero rake / already swept in a race) abort the run.
      console.warn(`  skip  ${market.toBase58()} — ${e.message || e}`);
    }
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
