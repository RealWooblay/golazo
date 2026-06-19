//! `lock_market` — authority closes betting. Open -> Locked.

use anchor_lang::prelude::*;

use crate::errors::GolazoError;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus};

#[derive(Accounts)]
pub struct LockMarket<'info> {
    /// Must be the market's authority. `has_one` enforces it against stored state.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ GolazoError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<LockMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    // Only an Open market can be locked. (Idempotency / double-lock is rejected.)
    require!(market.status == MarketStatus::Open, GolazoError::MarketNotOpen);
    market.status = MarketStatus::Locked;
    Ok(())
}
