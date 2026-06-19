//! `initialize_market` — create a Market + its lamport vault.
//!
//! VAULT MODEL (documented choice):
//! The vault is a dedicated, **data-less, system-owned PDA** at
//! seeds `["vault", market]`. We deliberately do NOT store bettor lamports on
//! the `Market` data account, because:
//!   * A System-owned account can receive lamports via a plain System Program
//!     `transfer` CPI (no special owner check), which is the cheapest, clearest
//!     deposit path for bettors.
//!   * On withdrawal we sign for the vault with its PDA seeds + bump, and move
//!     lamports by *direct balance mutation* (allowed because the program is the
//!     ... actually the vault is System-owned, so we use a System `transfer`
//!     CPI signed by the vault PDA — see `claim.rs`).
//!   * Keeping the vault separate means the Market's rent-exempt reserve is
//!     never entangled with the prize pool, so accounting stays exact.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::GolazoError;
use crate::events::MarketInitialized;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus, Outcome};

#[derive(Accounts)]
#[instruction(market_seed: u64)]
pub struct InitializeMarket<'info> {
    /// The operator. Pays rent for the Market account and optional seed.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The market PDA. Seeds bind it to (authority, market_seed) so the same
    /// operator can run many markets and nobody can squat another's address.
    #[account(
        init,
        payer = authority,
        space = Market::SIZE,
        seeds = [seeds::MARKET, authority.key().as_ref(), &market_seed.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    /// CHECK: Data-less, system-owned vault PDA holding all lamports for this
    /// market. We never deserialize it; it is validated purely by its PDA seeds
    /// and bump. It is created implicitly the first time lamports are sent to it
    /// (a System account needs no `init`).
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    market_seed: u64,
    question_hash: [u8; 32],
    rake_bps: u16,
    seed_yes: u64,
    seed_no: u64,
) -> Result<()> {
    // --- Validate inputs --------------------------------------------------
    // rake must be a proper fraction in bps; 10_000 (==100%) would zero the net
    // pool and make every multiple 0, so it is rejected.
    require!((rake_bps as u128) < crate::state::BPS_DENOMINATOR, GolazoError::InvalidRake);
    let total_seed = seed_yes
        .checked_add(seed_no)
        .ok_or_else(|| error!(GolazoError::MathOverflow))?;

    // --- Optional seed deposit: authority -> vault ------------------------
    // Zero is the normal pure-parimutuel path. Nonzero stays available for QA
    // or operator-seeded markets, but it is not required for payout solvency.
    if total_seed > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            total_seed,
        )?;
    }

    // --- Initialize Market state -----------------------------------------
    let market = &mut ctx.accounts.market;
    market.authority = ctx.accounts.authority.key();
    market.market_seed = market_seed;
    market.question_hash = question_hash;
    market.rake_bps = rake_bps;
    market.status = MarketStatus::Open;
    market.outcome = Outcome::None;
    // Optional seed starts in the pool; production zero-capital markets use 0/0.
    market.pool_yes = seed_yes;
    market.pool_no = seed_no;
    market.seed_yes = seed_yes;
    market.seed_no = seed_no;
    market.vault_bump = ctx.bumps.vault;
    market.bump = ctx.bumps.market;

    emit!(MarketInitialized {
        market: market.key(),
        authority: market.authority,
        market_seed,
        question_hash,
        rake_bps,
        seed_yes,
        seed_no,
    });

    Ok(())
}
