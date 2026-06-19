//! `resolve_market` — authority settles to a Yes/No outcome.
//!
//! Allowed from `Locked` (the normal flow) OR directly from `Open` (operator
//! convenience for a fast in-play settle). VOID has its own instruction
//! (`void_market`) so the two settlement branches can never be confused — this
//! mirrors core's `settle()` treating `'VOID'` as a separate code path.

use anchor_lang::prelude::*;

use crate::errors::GolazoError;
use crate::events::MarketResolved;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus, Outcome};

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ GolazoError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<ResolveMarket>, outcome: Outcome) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Resolvable only from Open or Locked — never re-resolve a settled market.
    require!(
        matches!(market.status, MarketStatus::Open | MarketStatus::Locked),
        GolazoError::MarketNotResolvable
    );
    // `resolve` is strictly for a real result. VOID must go through void_market.
    require!(
        matches!(outcome, Outcome::Yes | Outcome::No),
        GolazoError::InvalidOutcome
    );

    market.status = MarketStatus::Resolved;
    market.outcome = outcome;

    emit!(MarketResolved {
        market: market.key(),
        outcome,
        voided: false,
        pool_yes: market.pool_yes,
        pool_no: market.pool_no,
    });

    Ok(())
}
