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
  // The hardcoded WITHDRAW_AUTHORITY (committed dev keypair; pubkey matches the
  // const in lib.rs). It signs sweeps; rake lands in its own USX account.
  const withdrawAuthority = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "fixtures/withdraw-authority.json"),
          "utf8"
        )
      )
    )
  );
  let withdrawUsx: PublicKey;

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
    await airdrop(withdrawAuthority.publicKey, 2);
    withdrawUsx = await fundUsx(withdrawAuthority.publicKey, 0);
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

    it("winner (Alice) claims 95_000 USX + her Bet rent (SOL) is refunded", async () => {
      const [bet] = betPda(market, alice.publicKey);
      const before = await usxBalance(aliceUsx);
      const solBefore = await provider.connection.getBalance(alice.publicKey);
      const betRent = (await provider.connection.getAccountInfo(bet))!.lamports;

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

      // Bet account is CLOSED and its rent refunded to Alice (net of the tx fee).
      assert.isNull(await provider.connection.getAccountInfo(bet));
      const solAfter = await provider.connection.getBalance(alice.publicKey);
      assert.isAbove(solAfter - solBefore, betRent - 10_000); // ~rent back, minus fee
    });

    it("double-claim fails (Bet account is gone)", async () => {
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
      } catch (_e) {
        threw = true; // Bet PDA no longer exists → claim can't reload it
      }
      assert.isTrue(threw);
    });

    it("loser (Bob) claims 0 USX but still recovers his Bet rent", async () => {
      const [bet] = betPda(market, bob.publicKey);
      const before = await usxBalance(bobUsx);
      const solBefore = await provider.connection.getBalance(bob.publicKey);
      const betRent = (await provider.connection.getAccountInfo(bet))!.lamports;

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

      // Even as a loser, the Bet is closed and rent comes back (the incentive to claim).
      assert.isNull(await provider.connection.getAccountInfo(bet));
      const solAfter = await provider.connection.getBalance(bob.publicKey);
      assert.isAbove(solAfter - solBefore, betRent - 10_000);
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

      // Bet closed on the void refund too — no SOL left locked.
      assert.isNull(await provider.connection.getAccountInfo(bet));
    });

    it("double-claim on void fails too (Bet account is gone)", async () => {
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
      } catch (_e) {
        threw = true;
      }
      assert.isTrue(threw);
    });
  });

  // =========================================================================
  // RAKE SWEEP (hardcoded WITHDRAW_AUTHORITY)
  //
  // Market seed 3: rake 500 bps, dave 60_000 YES, erin 40_000 NO, resolve YES.
  //   gross = 100_000, net = 95_000, rake = 5_000.
  //   Sweep -> withdraw account +5_000, vault left = 95_000 (exactly the winner's
  //   net), so dave still claims his full 95_000 afterwards.
  // =========================================================================
  describe("rake sweep", () => {
    const marketSeed = new BN(3);
    const RAKE = 500;
    const dave = Keypair.generate();
    const erin = Keypair.generate();
    let market: PublicKey;
    let vault: PublicKey;
    let daveUsx: PublicKey;
    let erinUsx: PublicKey;

    before(async () => {
      [market] = marketPda(authority.publicKey, marketSeed);
      [vault] = vaultPda(market);
      await airdrop(dave.publicKey, 2);
      await airdrop(erin.publicKey, 2);
      daveUsx = await fundUsx(dave.publicKey, 1_000_000);
      erinUsx = await fundUsx(erin.publicKey, 1_000_000);

      await program.methods
        .initializeMarket(marketSeed, QUESTION_HASH, RAKE, new BN(0), new BN(0))
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

      for (const [bettor, token, side, stake] of [
        [dave, daveUsx, SIDE_YES, new BN(60_000)],
        [erin, erinUsx, SIDE_NO, new BN(40_000)],
      ] as const) {
        const [bet] = betPda(market, bettor.publicKey);
        await program.methods
          .placeBet(side, stake)
          .accounts({
            bettor: bettor.publicKey,
            market,
            vault,
            bettorToken: token,
            bet,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bettor])
          .rpc();
      }

      await program.methods
        .resolveMarket(OUTCOME_YES)
        .accounts({ authority: authority.publicKey, market })
        .rpc();
    });

    it("rejects sweep from a signer other than WITHDRAW_AUTHORITY", async () => {
      const stranger = Keypair.generate();
      await airdrop(stranger.publicKey, 1);
      const strangerUsx = await fundUsx(stranger.publicKey, 0);
      let threw = false;
      try {
        await program.methods
          .sweepRake()
          .accounts({
            withdrawAuthority: stranger.publicKey,
            market,
            vault,
            treasuryToken: strangerUsx,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([stranger])
          .rpc();
      } catch (_e) {
        threw = true;
      }
      assert.isTrue(threw, "non-withdraw-authority must not sweep");
    });

    it("withdraw authority sweeps rake (5_000) to its USX account", async () => {
      assert.equal((await usxBalance(vault)).toString(), "100000");
      const before = await usxBalance(withdrawUsx);

      await program.methods
        .sweepRake()
        .accounts({
          withdrawAuthority: withdrawAuthority.publicKey,
          market,
          vault,
          treasuryToken: withdrawUsx,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([withdrawAuthority])
        .rpc();

      const after = await usxBalance(withdrawUsx);
      assert.equal((after - before).toString(), "5000");
      // Vault now holds exactly the net pool owed to the winner.
      assert.equal((await usxBalance(vault)).toString(), "95000");

      const m = await program.account.market.fetch(market);
      assert.equal(m.rakeSwept, true);
    });

    it("rejects a second sweep (RakeAlreadySwept)", async () => {
      let threw = false;
      try {
        await program.methods
          .sweepRake()
          .accounts({
            withdrawAuthority: withdrawAuthority.publicKey,
            market,
            vault,
            treasuryToken: withdrawUsx,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([withdrawAuthority])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "RakeAlreadySwept");
      }
      assert.isTrue(threw);
    });

    it("winner still claims full net (95_000) after the sweep", async () => {
      const [bet] = betPda(market, dave.publicKey);
      const before = await usxBalance(daveUsx);
      await program.methods
        .claim()
        .accounts({
          bettor: dave.publicKey,
          market,
          vault,
          bettorToken: daveUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([dave])
        .rpc();
      const after = await usxBalance(daveUsx);
      assert.equal((after - before).toString(), "95000");
      assert.equal((await usxBalance(vault)).toString(), "0");
    });

    it("rejects sweep on a non-resolved (void) market", async () => {
      const voidSeed = new BN(4);
      const [vmarket] = marketPda(authority.publicKey, voidSeed);
      const [vvault] = vaultPda(vmarket);
      const frank = Keypair.generate();
      await airdrop(frank.publicKey, 2);
      const frankUsx = await fundUsx(frank.publicKey, 1_000_000);

      await program.methods
        .initializeMarket(voidSeed, QUESTION_HASH, RAKE, new BN(0), new BN(0))
        .accounts({
          authority: authority.publicKey,
          market: vmarket,
          usxMint: USX_MINT,
          vault: vvault,
          authorityToken: authorityUsx,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      const [bet] = betPda(vmarket, frank.publicKey);
      await program.methods
        .placeBet(SIDE_YES, new BN(10_000))
        .accounts({
          bettor: frank.publicKey,
          market: vmarket,
          vault: vvault,
          bettorToken: frankUsx,
          bet,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([frank])
        .rpc();
      await program.methods
        .voidMarket()
        .accounts({ authority: authority.publicKey, market: vmarket })
        .rpc();

      let threw = false;
      try {
        await program.methods
          .sweepRake()
          .accounts({
            withdrawAuthority: withdrawAuthority.publicKey,
            market: vmarket,
            vault: vvault,
            treasuryToken: withdrawUsx,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([withdrawAuthority])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "MarketNotResolved");
      }
      assert.isTrue(threw);
    });
  });
});
