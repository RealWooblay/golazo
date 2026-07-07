// GOLAZO — batch rent recovery. Scan every market, classify each as SAFE to
// close (settled + empty vault) or MUST-SKIP (still active, or vault still holds
// USX), then close all the SAFE ones the loaded wallet is authority for.
//
// Dry-run by default (lists only). Set CLOSE=1 to actually send the closes.
//
//   RPC_URL=https://api.mainnet-beta.solana.com \
//   WALLET=~/.config/solana/operator.json \
//   node scripts/close-all.mjs           # dry run — prints SAFE + SKIP lists
//   CLOSE=1 ... node scripts/close-all.mjs   # actually close the SAFE ones
//
// The program's on-chain gate is the real guarantee (it rejects any market that
// isn't Resolved/Void with an empty vault); this script just avoids attempting
// the ones that would revert, and writes the skip-list to close-skiplist.json.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "fs";
import { closeMarketIx } from "./close-market.mjs";

const PROGRAM_ID = new PublicKey("3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM");
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET = process.env.WALLET || `${process.env.HOME}/.config/solana/id.json`;
const DO_CLOSE = process.env.CLOSE === "1";

// Market layout (state.rs): total 119 bytes incl. 8-byte disc.
const MARKET_SIZE = 119;
const OFF_AUTHORITY = 8;   // Pubkey(32)
const OFF_SEED = 40;       // u64
const OFF_STATUS = 82;     // 0=Open 1=Locked 2=Resolved 3=Void
const STATUS = ["Open", "Locked", "Resolved", "Void"];
const SEED_VAULT = Buffer.from("vault");

const loadWallet = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const vaultPda = (market) => PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], PROGRAM_ID)[0];

async function getMulti(conn, pubs) {
  const out = [];
  for (let i = 0; i < pubs.length; i += 100) {
    let r;
    for (let a = 0; a < 4; a++) {
      try { r = await conn.getMultipleAccountsInfo(pubs.slice(i, i + 100), "confirmed"); break; }
      catch { await new Promise((x) => setTimeout(x, 1500)); }
    }
    out.push(...(r || pubs.slice(i, i + 100).map(() => null)));
  }
  return out;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const wallet = loadWallet(WALLET);
  const me = wallet.publicKey.toBase58();

  const mkts = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: MARKET_SIZE }] });
  const items = mkts.map(({ pubkey, account }) => ({
    market: pubkey,
    authority: new PublicKey(account.data.subarray(OFF_AUTHORITY, OFF_AUTHORITY + 32)).toBase58(),
    seed: account.data.readBigUInt64LE(OFF_SEED).toString(),
    status: STATUS[account.data.readUInt8(OFF_STATUS)],
    vault: vaultPda(pubkey),
  }));
  const vinfos = await getMulti(conn, items.map((x) => x.vault));

  const safe = [];
  const skip = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const vi = vinfos[i];
    it.vaultUsx = vi && vi.data && vi.data.length >= 72 ? Number(vi.data.readBigUInt64LE(64)) / 1e6 : 0;
    const settled = it.status === "Resolved" || it.status === "Void";
    const empty = it.vaultUsx === 0;
    if (settled && empty) {
      it.reason = "safe";
      safe.push(it);
    } else {
      it.reason = !settled ? `active (${it.status})` : `vault holds $${it.vaultUsx.toFixed(2)} USX`;
      skip.push(it);
    }
  }

  console.log(`${items.length} markets: ${safe.length} SAFE to close, ${skip.length} MUST-SKIP\n`);

  // Persist the skip-list (the markets that CANNOT be safely closed).
  writeFileSync(
    "close-skiplist.json",
    JSON.stringify(skip.map(({ market, authority, seed, status, vaultUsx, reason }) =>
      ({ market: market.toBase58(), authority, seed, status, vaultUsx, reason })), null, 2),
  );
  console.log("MUST-SKIP (cannot safely close — wrote close-skiplist.json):");
  for (const s of skip) {
    console.log(`  seed=${s.seed.padStart(10)} ${s.status.padEnd(8)} vault=$${s.vaultUsx.toFixed(2)}  ${s.reason}  ${s.market.toBase58().slice(0, 8)}…`);
  }

  const mine = safe.filter((s) => s.authority === me);
  const notMine = safe.length - mine.length;
  console.log(`\nSAFE to close: ${safe.length} (${mine.length} you are authority for, ${notMine} under another authority)`);

  if (!DO_CLOSE) {
    console.log(`\nDRY RUN. Re-run with CLOSE=1 to close the ${mine.length} markets you own.`);
    return;
  }

  let closed = 0, rentSol = 0;
  for (const s of mine) {
    try {
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction().add(closeMarketIx(s.market, wallet.publicKey)),
        [wallet],
        { commitment: "confirmed" },
      );
      closed++;
      rentSol += 0.00376; // ~market + vault rent reclaimed
      console.log(`  closed seed=${s.seed} — ${sig}`);
    } catch (e) {
      console.warn(`  skip  seed=${s.seed} — ${e.message || e}`);
    }
  }
  console.log(`\ndone — closed ${closed} markets, ~${rentSol.toFixed(4)} SOL reclaimed to ${me.slice(0, 8)}…`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
