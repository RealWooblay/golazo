// GOLAZO mainnet walkthrough CLI — drive ONE program action (or query) at a time
// so we can inspect state before/after every step.
//
//   node scripts/mkt.mjs balances
//   node scripts/mkt.mjs market <seed>
//   node scripts/mkt.mjs bet-acct <seed> <alice|bob>
//   node scripts/mkt.mjs init <seed>
//   node scripts/mkt.mjs bet <seed> <alice|bob> <yes|no> <usd>
//   node scripts/mkt.mjs lock <seed>
//   node scripts/mkt.mjs resolve <seed> <yes|no>
//   node scripts/mkt.mjs void <seed>
//   node scripts/mkt.mjs claim <seed> <alice|bob>
//   node scripts/mkt.mjs create-treasury-ata
//   node scripts/mkt.mjs sweep <seed>
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";

// repo root = three levels up from programs/golazo-parimutuel/scripts/
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey("3Ej5xzfeW9LFMK55JA1gZ7ew5hqkL8S7zh2tHabGmYYM");
const USX_MINT = new PublicKey("6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const conn = new Connection(RPC, "confirmed");

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace("~", homedir()), "utf8"))));
const KP = {
  operator: load("~/.config/solana/id.json"),
  alice: load(REPO + "keys/alice.json"),
  bob: load(REPO + "keys/bob.json"),
  treasury: load("~/.golazo/treasury.json"),
};
// Optional extra bettors (only loaded if generated) — e.g. keys/carol.json.
for (const name of ["carol", "dave"]) {
  const p = REPO + `keys/${name}.json`;
  if (existsSync(p)) KP[name] = load(p);
}

const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const pda = (seeds, prog = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ata = (owner) => pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USX_MINT.toBuffer()], ATA_PROGRAM);
const usx = (usd) => Math.round(usd * 1e6);
const $ = (base) => "$" + (Number(base) / 1e6).toFixed(6);
const SOLfmt = (lam) => (lam / LAMPORTS_PER_SOL).toFixed(6) + " SOL";

const marketPda = (seed) => pda([Buffer.from("market"), KP.operator.publicKey.toBuffer(), u64(seed)]);
const vaultPda = (m) => pda([Buffer.from("vault"), m.toBuffer()]);
const betPda = (m, bettor) => pda([Buffer.from("bet"), m.toBuffer(), bettor.toBuffer()]);

async function usxBal(owner) {
  try { return Number((await conn.getTokenAccountBalance(ata(owner), "confirmed")).value.amount); }
  catch { return null; } // no token account
}
async function vaultUsx(vault) {
  try { return Number((await conn.getTokenAccountBalance(vault, "confirmed")).value.amount); }
  catch { return null; }
}

function createAtaIdempotentIx(payer, owner) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: USX_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

const STATUS = ["Open", "Locked", "Resolved", "Void"];
const OUTCOME = ["None", "Yes", "No"];

async function send(ixs, signers, label) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
    ...ixs,
  );
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ✓ ${label}  tx: ${sig}`);
  return sig;
}

// ── queries ──────────────────────────────────────────────────────────────────
async function showBalances() {
  console.log(`RPC ${RPC}\n`);
  for (const [name, kp] of Object.entries(KP)) {
    const sol = await conn.getBalance(kp.publicKey, "confirmed");
    const u = await usxBal(kp.publicKey);
    console.log(`${name.padEnd(9)} ${kp.publicKey.toBase58()}`);
    console.log(`          SOL ${SOLfmt(sol).padEnd(16)} USX ${u === null ? "(no account)" : $(u)}`);
  }
}
async function showMarket(seed) {
  const m = marketPda(seed), v = vaultPda(m);
  console.log(`market seed=${seed}\n  market PDA ${m.toBase58()}\n  vault  PDA ${v.toBase58()}`);
  const info = await conn.getAccountInfo(m, "confirmed");
  if (!info) { console.log("  → market account: DOES NOT EXIST"); return; }
  const d = info.data;
  console.log(`  status   ${STATUS[d[82]]}`);
  console.log(`  outcome  ${OUTCOME[d[83]]}`);
  console.log(`  rake_bps ${d.readUInt16LE(80)}`);
  console.log(`  pool_yes ${$(d.readBigUInt64LE(84))}   pool_no ${$(d.readBigUInt64LE(92))}`);
  console.log(`  rake_swept ${d[118] === 1}`);
  const vb = await vaultUsx(v);
  console.log(`  vault USX ${vb === null ? "(no account)" : $(vb)}`);
}
async function showBet(seed, who) {
  const m = marketPda(seed), bet = betPda(m, KP[who].publicKey);
  const info = await conn.getAccountInfo(bet, "confirmed");
  console.log(`${who} bet PDA ${bet.toBase58()}`);
  if (!info) { console.log("  → bet account: DOES NOT EXIST (never placed, or closed on claim)"); return; }
  const d = info.data;
  console.log(`  side ${d[72] === 1 ? "No" : "Yes"}   stake ${$(d.readBigUInt64LE(73))}   claimed ${d[81] === 1}`);
}

// ── actions ──────────────────────────────────────────────────────────────────
async function init(seed, rakeBps = 600) {
  const m = marketPda(seed), v = vaultPda(m);
  const qhash = createHash("sha256").update(`mainnet walkthrough market ${seed}`).digest();
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: KP.operator.publicKey, isSigner: true, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: USX_MINT, isSigner: false, isWritable: false },
      { pubkey: v, isSigner: false, isWritable: true },
      { pubkey: ata(KP.operator.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("initialize_market"), u64(seed), qhash, u16(Number(rakeBps)), u64(0), u64(0)]),
  });
  await send([createAtaIdempotentIx(KP.operator.publicKey, KP.operator.publicKey), ix], [KP.operator], `init market ${seed} (rake ${rakeBps})`);
}
async function bet(seed, who, side, usd) {
  const m = marketPda(seed), v = vaultPda(m), bettor = KP[who];
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bettor.publicKey, isSigner: true, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: v, isSigner: false, isWritable: true },
      { pubkey: ata(bettor.publicKey), isSigner: false, isWritable: true },
      { pubkey: betPda(m, bettor.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_bet"), Buffer.from([side === "yes" ? 0 : 1]), u64(usx(Number(usd)))]),
  });
  await send([createAtaIdempotentIx(bettor.publicKey, bettor.publicKey), ix], [bettor], `${who} bet ${side} $${usd}`);
}
async function authorityOnly(seed, name, extraData = Buffer.alloc(0), signerWho = "operator") {
  const m = marketPda(seed);
  const signer = KP[signerWho];
  // marketPda always derives from the operator (the creator); passing a different
  // signer here as the `authority` account is exactly what exercises has_one.
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc(name), extraData]),
  });
  await send([ix], [signer], `${name} ${seed} (signed by ${signerWho})`);
}
async function claim(seed, who) {
  const m = marketPda(seed), v = vaultPda(m), bettor = KP[who];
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bettor.publicKey, isSigner: true, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: v, isSigner: false, isWritable: true },
      { pubkey: ata(bettor.publicKey), isSigner: false, isWritable: true },
      { pubkey: betPda(m, bettor.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: disc("claim"),
  });
  await send([ix], [bettor], `${who} claim ${seed}`);
}
async function createTreasuryAta() {
  await send([createAtaIdempotentIx(KP.treasury.publicKey, KP.treasury.publicKey)], [KP.treasury], "create treasury USX ATA");
}
async function sweep(seed, signerWho = "treasury") {
  const m = marketPda(seed), v = vaultPda(m);
  const signer = KP[signerWho];
  // treasury_token is always the real treasury's ATA; signing as someone else
  // trips the `address = WITHDRAW_AUTHORITY` check on the signer first.
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: true },
      { pubkey: v, isSigner: false, isWritable: true },
      { pubkey: ata(KP.treasury.publicKey), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: disc("sweep_rake"),
  });
  await send([ix], [signer], `sweep ${seed} (signed by ${signerWho})`);
}

// ── funding helpers (move SOL/USX between our own wallets) ─────────────────────
async function sendSol(from, to, sol) {
  const f = KP[from], t = KP[to];
  const ix = SystemProgram.transfer({
    fromPubkey: f.publicKey, toPubkey: t.publicKey,
    lamports: Math.round(Number(sol) * LAMPORTS_PER_SOL),
  });
  await send([ix], [f], `${from} → ${to}  ${sol} SOL`);
}
async function sendUsx(from, to, usd) {
  const f = KP[from], t = KP[to];
  const transferIx = new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: ata(f.publicKey), isSigner: false, isWritable: true },
      { pubkey: ata(t.publicKey), isSigner: false, isWritable: true },
      { pubkey: f.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), u64(usx(Number(usd)))]), // SPL Token Transfer = ix 3
  });
  await send([createAtaIdempotentIx(f.publicKey, t.publicKey), transferIx], [f], `${from} → ${to}  $${usd} USX`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = {
  balances: () => showBalances(),
  market: () => showMarket(args[0]),
  "bet-acct": () => showBet(args[0], args[1]),
  init: () => init(args[0], args[1]),
  bet: () => bet(args[0], args[1], args[2], args[3]),
  lock: () => authorityOnly(args[0], "lock_market", Buffer.alloc(0), args[1]),
  resolve: () =>
    authorityOnly(args[0], "resolve_market", Buffer.from([args[1] === "yes" ? 1 : 2]), args[2]),
  void: () => authorityOnly(args[0], "void_market", Buffer.alloc(0), args[1]),
  claim: () => claim(args[0], args[1]),
  "create-treasury-ata": () => createTreasuryAta(),
  sweep: () => sweep(args[0], args[1]),
  "send-sol": () => sendSol(args[0], args[1], args[2]),
  "send-usx": () => sendUsx(args[0], args[1], args[2]),
}[cmd];
if (!run) { console.error("unknown command:", cmd); process.exit(1); }
run().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
