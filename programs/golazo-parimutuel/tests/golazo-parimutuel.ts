/**
 * GOLAZO parimutuel — Anchor/Mocha integration tests.
 *
 * These run against a local validator that `anchor test` spins up. They cover:
 *   • initialize_market (zero seed allowed, status Open)
 *   • place_bet YES and NO grows the final pools
 *   • lock_market, resolve_market(Yes)
 *   • winner claim pays final proportional pool share, loser claim pays 0
 *   • double-claim fails
 *   • a full VOID round that refunds every stake
 *
 * The math is replicated here in TS (`parimutuelPayout`) so the
 * assertions are derived the same way the on-chain program derives them — this
 * IS the parity check against @golazo/core's integer mirror.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { GolazoParimutuel } from "../target/types/golazo_parimutuel";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
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

  // Side enum encodings for Anchor (variant objects).
  const SIDE_YES = { yes: {} };
  const SIDE_NO = { no: {} };
  const OUTCOME_YES = { yes: {} };

  // Helpers ----------------------------------------------------------------
  const QUESTION_HASH = Array.from({ length: 32 }, (_, i) => i); // dummy [u8;32]

  function marketPda(auth: PublicKey, seed: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        auth.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8),
      ],
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

  // =========================================================================
  // WORKED EXAMPLE (resolved, YES wins)
  //
  // seeds: YES = 0, NO = 0 lamports, rake = 500 bps (5%).
 //
  //   open pool  : yes=0       no=0
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

    // Expected value computed by the off-chain mirror.
    const expectedAlicePayout = parimutuelPayout(50_000n, 50_000n, 500n, "YES", 50_000n); // 95_000

    before(async () => {
      [market] = marketPda(authority.publicKey, marketSeed);
      [vault] = vaultPda(market);
      await airdrop(alice.publicKey, 2);
      await airdrop(bob.publicKey, 2);
    });

    it("hard-codes the by-hand expectations (sanity)", () => {
      assert.equal(expectedAlicePayout.toString(), "95000");
    });

    it("initializes the market with zero seed", async () => {
      await program.methods
        .initializeMarket(
          marketSeed,
          QUESTION_HASH,
          RAKE,
          SEED_YES,
          SEED_NO
        )
        .accounts({
          authority: authority.publicKey,
          market,
          vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const m = await program.account.market.fetch(market);
      assert.equal(m.poolYes.toString(), "0");
      assert.equal(m.poolNo.toString(), "0");
      assert.equal(m.seedYes.toString(), "0");
      assert.equal(m.seedNo.toString(), "0");
      assert.equal(m.rakeBps, RAKE);
      assert.deepEqual(m.status, { open: {} });
      assert.deepEqual(m.outcome, { none: {} });

      // Vault starts empty in zero-capital mode.
      const vaultBal = await provider.connection.getBalance(vault);
      assert.equal(vaultBal, 0);
    });

    it("Alice bets YES and grows the YES pool", async () => {
      const [bet] = betPda(market, alice.publicKey);
      await program.methods
        .placeBet(SIDE_YES, ALICE_STAKE)
        .accounts({
          bettor: alice.publicKey,
          market,
          vault,
          bet,
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
    });

    it("Bob bets NO and grows the NO pool", async () => {
      const [bet] = betPda(market, bob.publicKey);
      await program.methods
        .placeBet(SIDE_NO, BOB_STAKE)
        .accounts({
          bettor: bob.publicKey,
          market,
          vault,
          bet,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      const b = await program.account.bet.fetch(bet);
      assert.equal(b.stake.toString(), "50000");
      assert.deepEqual(b.side, { no: {} });

      const m = await program.account.market.fetch(market);
      assert.equal(m.poolYes.toString(), "50000");
      assert.equal(m.poolNo.toString(), "50000");
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
            bet,
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
      const [bet] = betPda(market, late.publicKey);
      let threw = false;
      try {
        await program.methods
          .placeBet(SIDE_YES, ALICE_STAKE)
          .accounts({
            bettor: late.publicKey,
            market,
            vault,
            bet,
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

    it("winner (Alice) claims her final proportional share = 95_000", async () => {
      const [bet] = betPda(market, alice.publicKey);
      const before = await provider.connection.getBalance(alice.publicKey);

      await program.methods
        .claim()
        .accounts({
          bettor: alice.publicKey,
          market,
          vault,
          bet,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const after = await provider.connection.getBalance(alice.publicKey);
      // Claim has no other lamport effects for the signer (no account creation),
      // so the delta is exactly the payout.
      assert.equal(after - before, Number(expectedAlicePayout));
      assert.equal(after - before, 95_000);

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
            bet,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
      } catch (e: any) {
        threw = true;
        assert.include(e.toString(), "AlreadyClaimed");
      }
      assert.isTrue(threw);
    });

    it("loser (Bob) claims 0 (no lamports moved, bet marked claimed)", async () => {
      const [bet] = betPda(market, bob.publicKey);
      const before = await provider.connection.getBalance(bob.publicKey);

      await program.methods
        .claim()
        .accounts({
          bettor: bob.publicKey,
          market,
          vault,
          bet,
          systemProgram: SystemProgram.programId,
        })
        .signers([bob])
        .rpc();

      const after = await provider.connection.getBalance(bob.publicKey);
      assert.equal(after - before, 0);

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

    before(async () => {
      [market] = marketPda(authority.publicKey, marketSeed);
      [vault] = vaultPda(market);
      await airdrop(carol.publicKey, 2);

      await program.methods
        .initializeMarket(marketSeed, QUESTION_HASH, RAKE, SEED, SEED)
        .accounts({
          authority: authority.publicKey,
          market,
          vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("Carol bets, then market is voided, then she is refunded exactly her stake", async () => {
      const [bet] = betPda(market, carol.publicKey);

      await program.methods
        .placeBet(SIDE_NO, STAKE)
        .accounts({
          bettor: carol.publicKey,
          market,
          vault,
          bet,
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();

      // Void the whole market.
      await program.methods
        .voidMarket()
        .accounts({ authority: authority.publicKey, market })
        .rpc();
      const m = await program.account.market.fetch(market);
      assert.deepEqual(m.status, { void: {} });

      const before = await provider.connection.getBalance(carol.publicKey);
      await program.methods
        .claim()
        .accounts({
          bettor: carol.publicKey,
          market,
          vault,
          bet,
          systemProgram: SystemProgram.programId,
        })
        .signers([carol])
        .rpc();
      const after = await provider.connection.getBalance(carol.publicKey);

      // Full stake back, no rake on void.
      assert.equal(after - before, Number(STAKE));
      assert.equal(after - before, 70_000);

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
            bet,
            systemProgram: SystemProgram.programId,
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
