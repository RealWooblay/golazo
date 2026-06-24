//! # GOLAZO — on-chain settlement layer
//!
//! A pure **parimutuel binary market**, the on-chain mirror of
//! `packages/core/src/parimutuel.ts`.
//!
//! ## Settlement asset
//! The protocol settles in the **USX stablecoin** (an SPL *classic* token), not
//! native SOL. Every stake, payout, refund, and rake is denominated in USX base
//! units. The single mint is pinned program-wide via [`USX_MINT`]; the per-market
//! vault is a PDA-owned USX token account whose authority is the Market PDA.
//!
//! ## Mechanism (why this, not a bonding curve)
//! All YES + NO stakes form ONE pool. The operator skims a fixed `rake` off the
//! gross pool on non-void settlement. Winners claim their proportional share of
//! the final net pool; losers get nothing; a VOID refunds every stake. There is
//! no house-backed fixed payout and no required house seed.
//!
//! ## Integer math (the contract with @golazo/core)
//! On-chain everything is integer **basis points (1e4)** with **u128**
//! intermediates, the exact mirror of the off-chain floats:
//! ```text
//! gross           = pool_yes + pool_no
//! net             = gross * (10_000 - rake_bps) / 10_000
//! winner_payout   = stake * net / final_winning_side_pool
//! ```
//!
//! ## Code layout
//! Split into modules for reviewability:
//!   * `state`        — accounts (`Market`, `Bet`) + the pure bps math.
//!   * `errors`       — all `#[error_code]` variants.
//!   * `events`       — Anchor `#[event]`s for indexers/the app.
//!   * `instructions` — one file per instruction (Accounts + handler).
//! `lib.rs` is just the thin `#[program]` entrypoint forwarding to handlers.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{Outcome, Side};

// Program id — synced to the built program keypair
// (target/deploy/golazo_parimutuel-keypair.json) so the on-chain id, the
// declared id, and every PDA derivation agree. Keep Anchor.toml in sync.
declare_id!("GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu");

/// The one stablecoin the whole protocol settles in: **USX** (SPL classic).
///
/// Pinned program-wide so a market vault, a bet deposit, or a payout can only
/// ever move USX — every token account in every instruction is constrained to
/// this mint (`token::mint = USX_MINT` / `address = USX_MINT`), making a
/// wrong-mint vault unconstructable. Changing the settlement asset is a redeploy.
///
/// The real mainnet USX mint can't be recreated on a local validator (we don't
/// hold its keypair), so integration tests build with `--features local-mint`,
/// which swaps in a committed test mint (`tests/fixtures/usx-mint.json`) we can
/// mint freely. Production builds (no feature) always use the real USX mint.
#[cfg(not(feature = "local-mint"))]
pub const USX_MINT: Pubkey = pubkey!("6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG");
#[cfg(feature = "local-mint")]
pub const USX_MINT: Pubkey = pubkey!("3kuxNXDwqUyyUeJVGxKa1judTjoe3u4Zu8Mgmbmi28S7");

/// The single address allowed to sweep operator rake out of market vaults.
///
/// Hardcoded by design: `sweep_rake` requires this exact signer, and rake is
/// sent to a USX account this key owns. Rotating it is a one-line change + a
/// program redeploy (the program is upgradeable).
///
/// Production builds use the real treasury address. Integration tests build with
/// `--features local-mint` and use a committed dev keypair (tests/fixtures) so
/// the suite can sign sweeps. Rotating the production key is a one-line change
/// here + a program upgrade.
#[cfg(not(feature = "local-mint"))]
pub const WITHDRAW_AUTHORITY: Pubkey = pubkey!("4AtHbn4LxGVEP4RmtEwx6cNq2peEZsgH7jUZFZMVddW9");
#[cfg(feature = "local-mint")]
pub const WITHDRAW_AUTHORITY: Pubkey = pubkey!("5K8KTZekMGpQ7dsjPQnMdNpjgUHzXcuPtYwJPXGw1aDs");

#[program]
pub mod golazo_parimutuel {
    use super::*;

    /// `WITHDRAW_AUTHORITY`-only. Sweep a resolved market's operator rake
    /// (gross - net) from the vault to a USX account that authority owns.
    /// Single-shot per market.
    pub fn sweep_rake(ctx: Context<SweepRake>) -> Result<()> {
        instructions::sweep_rake::handler(ctx)
    }

    /// Create a market + its USX token vault and open for betting.
    /// `rake_bps` must be < 10_000; seeds (USX base units) may be zero.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_seed: u64,
        question_hash: [u8; 32],
        rake_bps: u16,
        seed_yes: u64,
        seed_no: u64,
    ) -> Result<()> {
        instructions::initialize_market::handler(
            ctx,
            market_seed,
            question_hash,
            rake_bps,
            seed_yes,
            seed_no,
        )
    }

    /// Back `side` with `stake` USX base units. Moves the stake into the vault,
    /// then grows the side pool.
    /// One bet per (market, bettor). Requires the market to be Open.
    pub fn place_bet(ctx: Context<PlaceBet>, side: Side, stake: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, side, stake)
    }

    /// Authority-only. Close betting: Open -> Locked.
    pub fn lock_market(ctx: Context<LockMarket>) -> Result<()> {
        instructions::lock_market::handler(ctx)
    }

    /// Authority-only. Settle to a real result (Yes/No): Open|Locked -> Resolved.
    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: Outcome) -> Result<()> {
        instructions::resolve_market::handler(ctx, outcome)
    }

    /// Authority-only. Cancel the market: Open|Locked -> Void (everyone refunds).
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        instructions::void_market::handler(ctx)
    }

    /// Claim a single bet against a Resolved or Void market. Winner gets their
    /// proportional net-pool share; void refunds `stake`; loser gets 0. In all
    /// cases the Bet account is closed and its rent refunded to the bettor, so no
    /// SOL stays locked per bet.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}
