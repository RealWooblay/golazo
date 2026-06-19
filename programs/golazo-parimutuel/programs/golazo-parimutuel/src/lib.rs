//! # GOLAZO — on-chain settlement layer
//!
//! A pure **parimutuel binary market**, the on-chain mirror of
//! `packages/core/src/parimutuel.ts`.
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

#[program]
pub mod golazo_parimutuel {
    use super::*;

    /// Create a market + its lamport vault and open for betting.
    /// `rake_bps` must be < 10_000; seeds may be zero.
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

    /// Back `side` with `stake` lamports. Moves the stake into the vault, then
    /// grows the side pool.
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
    /// proportional net-pool share; void refunds `stake`; loser gets 0.
    /// Idempotent-safe via the `claimed` flag.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}
