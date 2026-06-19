//! `void_market` — authority cancels the market; everyone refunds their stake.
//!
//! Used for any ambiguity / timing fault, mirroring core's `outcome === 'VOID'`
//! branch: no rake is taken and every bettor can claim back exactly their stake.

use anchor_lang::prelude::*;

use crate::errors::GolazoError;
use crate::events::MarketResolved;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus, Outcome};

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ GolazoError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<VoidMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Voidable only from Open or Locked — never void a market already settled.
    require!(
        matches!(market.status, MarketStatus::Open | MarketStatus::Locked),
        GolazoError::MarketNotResolvable
    );

    market.status = MarketStatus::Void;
    market.outcome = Outcome::None; // VOID is not a winning side.

    emit!(MarketResolved {
        market: market.key(),
        outcome: Outcome::None,
        voided: true,
        pool_yes: market.pool_yes,
        pool_no: market.pool_no,
    });

    Ok(())
}
