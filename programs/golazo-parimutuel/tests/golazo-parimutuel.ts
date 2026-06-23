/**
 * GOLAZO parimutuel — Anchor/Mocha integration tests (USX settlement).
 *
 * The protocol settles in the USX stablecoin (SPL classic), not native SOL.
 * These tests build the program with `--features local-mint`, which pins
 * USX_MINT to the committed test mint (tests/fixtures/usx-mint.json) we create
 * and fund here. Run with:
 *
 *   anchor test --validator legacy -- --features local-mint
 *
 * (`--validator legacy` uses solana-test-validator; Anchor 1.0 defaults to
 * surfpool, which isn't required here.)
 *
 * Coverage:
 *   • initialize_market (zero seed, status Open, vault is a USX token account)
 *   • place_bet YES and NO moves USX into the vault and grows the pools
 *   • lock_market, resolve_market(Yes)
 *   • winner claim pays final proportional pool share in USX, loser claims 0
 *   • double-claim fails
 *   • a full VOID round that refunds every stake in USX
 *
 * The math is replicated here in TS (`parimutuelPayout`) so the assertions are
 * derived the same way the on-chain program derives them — the parity check
 * against @golazo/core's integer mirror.
 */

import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { GolazoParimutuel } from "../target/types/golazo_parimutuel";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

// ---------------------------------------------------------------------------
// Off-chain integer mirror (same formula as packages/core/src/parimutuel.ts,
// expressed in bps). We assert the on-chain program produces exactly these.
// ---------------------------------------------------------------------------
const BPS = 10_000n;

/** net = gross * (10000 - rake) / 10000 */
function netBps(poolYes: bigint, poolNo: bigint, rakeBps: bigint): bigint {
  const gross = poolYes + poolNo;
  return (gross * (BPS - rakeBps)) / BPS;
}

/** winner payout = stake / final winning side pool * net */
function parimutuelPayout(
  poolYes: bigint,
  poolNo: bigint,
  rakeBps: bigint,
  side: "YES" | "NO",
  stake: bigint
): bigint {
  const net = netBps(poolYes, poolNo, rakeBps);
  const winningPool = side === "YES" ? poolYes : poolNo;
  return winningPool > 0n ? (stake * net) / winningPool : 0n;
}

describe("golazo-parimutuel", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .GolazoParimutuel as Program<GolazoParimutuel>;

  const authority = (provider.wallet as anchor.Wallet).payer;

  // The committed test mint keypair — its pubkey is pinned as USX_MINT when the
  // program is built with `--features local-mint`.
  const usxMintKp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, "fixtures/usx-mint.json"), "utf8")
      )
    )
  );
  const USX_MINT = usxMintKp.publicKey;
  const USX_DECIMALS = 6;

  // Side enum encodings for Anchor (variant objects).
  const SIDE_YES = { yes: {} };
  const SIDE_NO = { no: {} };
  const OUTCOME_YES = { yes: {} };

  // Helpers ----------------------------------------------------------------
  const QUESTION_HASH = Array.from({ length: 32 }, (_, i) => i); // dummy [u8;32]

  function marketPda(auth: PublicKey, seed: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), auth.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }
  function vaultPda(market: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market.toBuffer()],
      program.programId
    );
  }
  function betPda(market: PublicKey, bettor: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), market.toBuffer(), bettor.toBuffer()],
      program.programId
    );
  }

  async function airdrop(pk: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pk,
      sol * LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });
  }

  /** Create the bettor's USX ATA (authority pays) and mint `amount` USX to it. */
  async function fundUsx(owner: PublicKey, amount: number): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority, // payer
      USX_MINT,
      owner,
      true
    );
    if (amount > 0) {
      await mintTo(
        provider.connection,
        authority, // payer
        USX_MINT,
        ata.address,
        authority, // mint authority
        amount
      );
    }
    return ata.address;
  }

  async function usxBalance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(provider.connection, ata)).amount;
  }

  // Authority's own USX account — required by initialize_market (seed source).
  let authorityUsx: PublicKey;

  before(async () => {
    // Create the USX mint at the committed test-mint address; authority is the
    // mint + freeze authority so we can fund test users.
    await createMint(
      provider.connection,
      authority, // payer
      authority.publicKey, // mint authority
      authority.publicKey, // freeze authority
      USX_DECIMALS,
      usxMintKp
    );
    authorityUsx = await fundUsx(authority.publicKey, 0);
  });

  // =========================================================================
  // WORKED EXAMPLE (resolved, YES wins)
  //
  // seeds: YES = 0, NO = 0 USX, rake = 500 bps (5%).
  //
  //   Alice bets 50_000 on YES -> pool yes=50_000
  //   Bob bets 50_000 on NO    -> pool no=50_000
  //
  //   resolve YES:
  //     gross = 100_000, net = 95_000
  //     Alice owns 50_000 / 50_000 of the winning side -> payout 95_000
  //     Bob loses -> payout 0
  // =========================================================================
  describe("resolved market (YES wins) — worked example", () => {
    const marketSeed = new BN(1);
    const RAKE = 500;
    const SEED_YES = new BN(0);
    const SEED_NO = new BN(0);
    const ALICE_STAKE = new BN(50_000);
    const BOB_STAKE = new BN(50_000);

    const alice = Keypair.generate();
    const bob = Keypair.generate();

    let market: PublicKey;
    let vault: PublicKey;
    let aliceUsx: PublicKey;
    let bobUsx: PublicKey;

    // Expected value computed by the off-chain mirror.
    const expectedAlicePayout = parimutuelPayout(50_000n, 50_000n, 500n, "YES", 50_000n); // 95_000

    before(async () => {
      [market] = marketPda(authority.publicKey, marketSeed);
      [vault] = vaultPda(market);
      await airdrop(alice.publicKey, 2);
      await airdrop(bob.publicKey, 2);
      aliceUsx = await fundUsx(alice.publicKey, 1_000_000);
      bobUsx = await fundUsx(bob.publicKey, 1_000_000);
    });

    it("hard-codes the by-hand expectations (sanity)", () => {
      assert.equal(expectedAlicePayout.toString(), "95000");
    });

    it("initializes the market with zero seed", async () => {
      await program.methods
        .initializeMarket(marketSeed, QUESTION_HASH, RAKE, SEED_YES, SEED_NO)
        .accounts({
          authority: authority.publicKey,
          market,
          usxMint: USX_MINT,
          vault,
          authorityToken: authorityUsx,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const m = await program.account.market.fetch(market);
      assert.equal(m.poolYes.toString(), "0");
      assert.equal(m.poolNo.toString(), "0");
      assert.equal(m.rakeBps, RAKE);
      assert.deepEqual(m.status, { open: {} });
      assert.deepEqual(m.outcome, { none: {} });

      // Vault is a USX token account holding zero USX (token rent is separate SOL).
      assert.equal((await usxBalance(vault)).toString(), "0");
    });

    it("Alice bets YES and grows the YES pool", async () => {
      const [bet] = betPda(market, alice.publicKey);
      await program.methods
        .placeBet(SIDE_YES, ALICE_STAKE)
        .accounts({
          bettor: alice.publicKey,
          market,
          vault,
          bettorToken: aliceUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const b = await program.account.bet.fetch(bet);
      assert.equal(b.stake.toString(), "50000");
      assert.deepEqual(b.side, { yes: {} });
      assert.equal(b.claimed, false);

      const m = await program.account.market.fetch(market);
      assert.equal(m.poolYes.toString(), "50000");
      assert.equal(m.poolNo.toString(), "0");
      assert.equal((await usxBalance(vault)).toString(), "50000");
    });

    it("Bob bets NO and grows the NO pool", async () => {
      const [bet] = betPda(market, bob.publicKey);
      await program.methods
        .placeBet(SIDE_NO, BOB_STAKE)
        .accounts({
          bettor: bob.publicKey,
          market,
          vault,
          bettorToken: bobUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      const m = await program.account.market.fetch(market);
      assert.equal(m.poolYes.toString(), "50000");
      assert.equal(m.poolNo.toString(), "50000");
      assert.equal((await usxBalance(vault)).toString(), "100000");
    });

    it("rejects a second bet from the same bettor (one bet per market)", async () => {
      const [bet] = betPda(market, alice.publicKey);
      let threw = false;
      try {
        await program.methods
          .placeBet(SIDE_YES, ALICE_STAKE)
          .accounts({
            bettor: alice.publicKey,
            market,
            vault,
            bettorToken: aliceUsx,
            bet,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
      } catch (_e) {
        threw = true; // account already in use -> init fails
      }
      assert.isTrue(threw, "expected re-bet to fail");
    });

    it("locks the market (Open -> Locked)", async () => {
      await program.methods
        .lockMarket()
        .accounts({ authority: authority.publicKey, market })
        .rpc();
      const m = await program.account.market.fetch(market);
      assert.deepEqual(m.status, { locked: {} });
    });

    it("rejects place_bet once locked", async () => {
      const late = Keypair.generate();
      await airdrop(late.publicKey, 1);
      const lateUsx = await fundUsx(late.publicKey, 100_000);
      const [bet] = betPda(market, late.publicKey);
      let threw = false;
      try {
        await program.methods
          .placeBet(SIDE_YES, ALICE_STAKE)
          .accounts({
            bettor: late.publicKey,
            market,
            vault,
            bettorToken: lateUsx,
            bet,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([late])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "MarketNotOpen");
      }
      assert.isTrue(threw);
    });

    it("rejects resolve from a non-authority signer", async () => {
      const stranger = Keypair.generate();
      await airdrop(stranger.publicKey, 1);
      let threw = false;
      try {
        await program.methods
          .resolveMarket(OUTCOME_YES)
          .accounts({ authority: stranger.publicKey, market })
          .signers([stranger])
          .rpc();
      } catch (_e) {
        threw = true; // has_one / seeds mismatch
      }
      assert.isTrue(threw);
    });

    it("resolves YES (authority only)", async () => {
      await program.methods
        .resolveMarket(OUTCOME_YES)
        .accounts({ authority: authority.publicKey, market })
        .rpc();
      const m = await program.account.market.fetch(market);
      assert.deepEqual(m.status, { resolved: {} });
      assert.deepEqual(m.outcome, { yes: {} });
    });

    it("winner (Alice) claims her final proportional share = 95_000 USX", async () => {
      const [bet] = betPda(market, alice.publicKey);
      const before = await usxBalance(aliceUsx);

      await program.methods
        .claim()
        .accounts({
          bettor: alice.publicKey,
          market,
          vault,
          bettorToken: aliceUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();

      const after = await usxBalance(aliceUsx);
      assert.equal((after - before).toString(), expectedAlicePayout.toString());
      assert.equal((after - before).toString(), "95000");

      // Rake remainder (gross - net = 5_000) stays in the vault.
      assert.equal((await usxBalance(vault)).toString(), "5000");

      const b = await program.account.bet.fetch(bet);
      assert.equal(b.claimed, true);
    });

    it("double-claim fails (AlreadyClaimed)", async () => {
      const [bet] = betPda(market, alice.publicKey);
      let threw = false;
      try {
        await program.methods
          .claim()
          .accounts({
            bettor: alice.publicKey,
            market,
            vault,
            bettorToken: aliceUsx,
            bet,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([alice])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "AlreadyClaimed");
      }
      assert.isTrue(threw);
    });

    it("loser (Bob) claims 0 (no USX moved, bet marked claimed)", async () => {
      const [bet] = betPda(market, bob.publicKey);
      const before = await usxBalance(bobUsx);

      await program.methods
        .claim()
        .accounts({
          bettor: bob.publicKey,
          market,
          vault,
          bettorToken: bobUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();

      const after = await usxBalance(bobUsx);
      assert.equal((after - before).toString(), "0");

      const b = await program.account.bet.fetch(bet);
      assert.equal(b.claimed, true);
    });
  });

  // =========================================================================
  // VOID round — every stake refunded in full, no rake.
  // =========================================================================
  describe("void market — full refunds", () => {
    const marketSeed = new BN(2);
    const RAKE = 500;
    const SEED = new BN(0);
    const STAKE = new BN(70_000);

    const carol = Keypair.generate();
    let market: PublicKey;
    let vault: PublicKey;
    let carolUsx: PublicKey;

    before(async () => {
      [market] = marketPda(authority.publicKey, marketSeed);
      [vault] = vaultPda(market);
      await airdrop(carol.publicKey, 2);
      carolUsx = await fundUsx(carol.publicKey, 1_000_000);

      await program.methods
        .initializeMarket(marketSeed, QUESTION_HASH, RAKE, SEED, SEED)
        .accounts({
          authority: authority.publicKey,
          market,
          usxMint: USX_MINT,
          vault,
          authorityToken: authorityUsx,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("Carol bets, the market is voided, then she is refunded exactly her stake", async () => {
      const [bet] = betPda(market, carol.publicKey);

      await program.methods
        .placeBet(SIDE_NO, STAKE)
        .accounts({
          bettor: carol.publicKey,
          market,
          vault,
          bettorToken: carolUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();

      await program.methods
        .voidMarket()
        .accounts({ authority: authority.publicKey, market })
        .rpc();
      const m = await program.account.market.fetch(market);
      assert.deepEqual(m.status, { void: {} });

      const before = await usxBalance(carolUsx);
      await program.methods
        .claim()
        .accounts({
          bettor: carol.publicKey,
          market,
          vault,
          bettorToken: carolUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([carol])
        .rpc();
      const after = await usxBalance(carolUsx);

      // Full stake back, no rake on void.
      assert.equal((after - before).toString(), STAKE.toString());
      assert.equal((after - before).toString(), "70000");
      assert.equal((await usxBalance(vault)).toString(), "0");

      const b = await program.account.bet.fetch(bet);
      assert.equal(b.claimed, true);
    });

    it("double-claim on void fails too", async () => {
      const [bet] = betPda(market, carol.publicKey);
      let threw = false;
      try {
        await program.methods
          .claim()
          .accounts({
            bettor: carol.publicKey,
            market,
            vault,
            bettorToken: carolUsx,
            bet,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([carol])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "AlreadyClaimed");
      }
      assert.isTrue(threw);
    });
  });
});
