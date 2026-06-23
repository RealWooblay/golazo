// GOLAZO on-chain demo — drives the DEPLOYED parimutuel program with REAL
// Solana transactions (no IDL needed: we build instructions from the same
// Anchor discriminators + borsh layout the program uses).
//
//   init market (house seeds both pools) -> Alice bets YES -> Bob bets NO
//   -> authority resolves YES -> Alice (winner) claims -> Bob (loser) claims
//
// The protocol settles in USX (SPL classic), so this creates a local USX mint
// (from the committed tests/fixtures/usx-mint.json — the pubkey the program
// pins under `--features local-mint`), funds the players' USX accounts, then
// runs the lifecycle. Prints every tx + on-chain state + the vault residual
// (the house rake retained for the treasury). Run against a localnet validator
// with the program deployed via `--features local-mint`.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, getAccount,
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const RPC = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey("GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu");
const SYS = SystemProgram.programId;
const USX_DECIMALS = 6;
const usx = (n) => Math.round(n * 10 ** USX_DECIMALS); // $ → USX base units
const fmt = (u) => "$" + (Number(u) / 10 ** USX_DECIMALS).toFixed(2);

// The committed test mint keypair — its pubkey is what the program pins when
// built with `--features local-mint`.
const usxMintKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(new URL("../tests/fixtures/usx-mint.json", import.meta.url)))),
);

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u8 = (n) => Buffer.from([n]);

const conn = new Connection(RPC, "confirmed");

async function fund(kp, sols) {
  const sig = await conn.requestAirdrop(kp.publicKey, Math.round(sols * LAMPORTS_PER_SOL));
  await conn.confirmTransaction(sig, "confirmed");
}
async function send(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
function pda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]; }

function parseMarket(data) {
  const d = data.subarray(8); // skip account discriminator
  return {
    status: ["Open", "Locked", "Resolved", "Void"][d[82 - 8 + 0]], // status byte
    outcome: ["None", "Yes", "No"][d[83 - 8 + 0]],
    poolYes: Number(d.readBigUInt64LE(84 - 8)),
    poolNo: Number(d.readBigUInt64LE(92 - 8)),
  };
}

/** USX balance of a token account (base units), 0 if it doesn't exist. */
async function usxBal(ata) {
  try { return Number((await getAccount(conn, ata)).amount); } catch { return 0; }
}

(async () => {
  console.log("RPC:", RPC, "\nProgram:", PROGRAM_ID.toBase58(), "\n");
  const info = await conn.getAccountInfo(PROGRAM_ID);
  console.log("Program deployed on-chain:", !!info, "| executable:", info?.executable, "\n");

  // Players (SOL funds them for tx fees; USX is the stake asset).
  const authority = Keypair.generate(); // the operator / house
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  for (const [k, who] of [[authority, "authority"], [alice, "Alice"], [bob, "Bob"]]) {
    await fund(k, 5);
    console.log(`funded ${who}: ${k.publicKey.toBase58().slice(0, 8)}…`);
  }

  // USX mint at the pinned test address; authority is the mint authority.
  await createMint(conn, authority, authority.publicKey, null, USX_DECIMALS, usxMintKp);
  const mint = usxMintKp.publicKey;
  console.log("USX mint:", mint.toBase58());

  // USX accounts: authority (seed source), Alice + Bob (bettors). Mint them USX.
  const authorityUsx = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, authority.publicKey)).address;
  const aliceUsx = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, alice.publicKey)).address;
  const bobUsx = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, bob.publicKey)).address;
  await mintTo(conn, authority, mint, authorityUsx, authority, usx(1)); // seed funds
  await mintTo(conn, authority, mint, aliceUsx, authority, usx(5));
  await mintTo(conn, authority, mint, bobUsx, authority, usx(5));

  // PDAs
  const marketSeed = 7;
  const market = pda([Buffer.from("market"), authority.publicKey.toBuffer(), u64(marketSeed)]);
  const vault = pda([Buffer.from("vault"), market.toBuffer()]);
  const betA = pda([Buffer.from("bet"), market.toBuffer(), alice.publicKey.toBuffer()]);
  const betB = pda([Buffer.from("bet"), market.toBuffer(), bob.publicKey.toBuffer()]);
  console.log("\nmarket PDA:", market.toBase58(), "\nvault  PDA:", vault.toBase58(), "\n");

  // 1) initialize_market — house seeds $0.05 YES / $0.05 NO, 6% rake
  const qhash = createHash("sha256").update("Mexico on the attack — GOAL?").digest();
  const sig1 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: authorityUsx, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYS, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("initialize_market"), u64(marketSeed), qhash, u16(600), u64(usx(0.05)), u64(usx(0.05))]),
  })], [authority]);
  console.log("① initialize_market  tx:", sig1);

  // 2) Alice bets YES $0.30
  const sig2 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: alice.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: aliceUsx, isSigner: false, isWritable: true },
      { pubkey: betA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_bet"), u8(0 /*Yes*/), u64(usx(0.30))]),
  })], [alice]);
  console.log("② Alice bet YES $0.30 tx:", sig2);

  // 3) Bob bets NO $0.20
  const sig3 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bob.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: bobUsx, isSigner: false, isWritable: true },
      { pubkey: betB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("place_bet"), u8(1 /*No*/), u64(usx(0.20))]),
  })], [bob]);
  console.log("③ Bob bet NO $0.20   tx:", sig3);

  let m = parseMarket((await conn.getAccountInfo(market)).data);
  console.log(`\n   on-chain pools → YES ${fmt(m.poolYes)} | NO ${fmt(m.poolNo)} | vault ${fmt(await usxBal(vault))} | status ${m.status}`);

  // 4) resolve YES
  const sig4 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("resolve_market"), u8(1 /*Yes*/)]),
  })], [authority]);
  console.log("\n④ resolve_market YES tx:", sig4);

  // 5) Alice (winner) claims — paid in USX to her token account
  const aliceBefore = await usxBal(aliceUsx);
  const sig5 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: alice.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: aliceUsx, isSigner: false, isWritable: true },
      { pubkey: betA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc("claim"),
  })], [alice]);
  const aliceAfter = await usxBal(aliceUsx);
  console.log("⑤ Alice claim       tx:", sig5, `   → received ${fmt(aliceAfter - aliceBefore)} USX`);

  // 6) Bob (loser) claims → 0, just closes the bet
  const sig6 = await send([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bob.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: bobUsx, isSigner: false, isWritable: true },
      { pubkey: betB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc("claim"),
  })], [bob]);
  console.log("⑥ Bob claim (lost)  tx:", sig6, "   → received $0.00");

  // Final: vault residual = the house rake retained for the treasury
  m = parseMarket((await conn.getAccountInfo(market)).data);
  const vaultFinal = await usxBal(vault);
  const gross = m.poolYes + m.poolNo;
  console.log(`\n   RESOLVED ${m.outcome} | gross pool ${fmt(gross)}`);
  console.log(`   vault residual (house rake → treasury): ${fmt(vaultFinal)}  ≈ ${((vaultFinal / gross) * 100).toFixed(2)}% of gross`);
  console.log("\n✓ Real on-chain USX parimutuel lifecycle complete.");
})().catch((e) => { console.error("DEMO ERROR:", e.message); process.exit(1); });
