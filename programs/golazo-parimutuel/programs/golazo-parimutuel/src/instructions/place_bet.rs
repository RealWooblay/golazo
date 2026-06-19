//! `place_bet` — back a side, deposit the stake, grow the selected pool.
//!
//! No payout is locked at bet time. Settlement later pays each winner their
//! proportional share of the final net pool.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::GolazoError;
use crate::events::BetPlaced;
use crate::instructions::seeds;
use crate::state::{Bet, Market, MarketStatus, Side};

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    /// The bettor — signs, pays rent for the Bet PDA, and funds the stake.
    #[account(mut)]
    pub bettor: Signer<'info>,

    /// The market being bet into. Must be Open (checked in the handler).
    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: the lamport vault for this market, validated by seeds + stored bump.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// One Bet PDA per (market, bettor). `init` here FAILS if it already exists,
    /// which is exactly the "one bet per user per market" guard (surfaces as the
    /// system/anchor "account already in use" error; see BetExists doc note).
    #[account(
        init,
        payer = bettor,
        space = Bet::SIZE,
        seeds = [seeds::BET, market.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bet: Account<'info, Bet>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, side: Side, stake: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // --- Guards -----------------------------------------------------------
    require!(market.status == MarketStatus::Open, GolazoError::MarketNotOpen);
    require!(stake > 0, GolazoError::ZeroStake);

    // --- Move the stake: bettor -> vault ----------------------------------
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        stake,
    )?;

    // --- NOW grow the side pool ------------------------------------------
    match side {
        Side::Yes => {
            market.pool_yes = market
                .pool_yes
                .checked_add(stake)
                .ok_or_else(|| error!(GolazoError::MathOverflow))?;
        }
        Side::No => {
            market.pool_no = market
                .pool_no
                .checked_add(stake)
                .ok_or_else(|| error!(GolazoError::MathOverflow))?;
        }
    }

    // --- Persist the Bet --------------------------------------------------
    let bet = &mut ctx.accounts.bet;
    bet.market = market.key();
    bet.bettor = ctx.accounts.bettor.key();
    bet.side = side;
    bet.stake = stake;
    bet.claimed = false;
    bet.bump = ctx.bumps.bet;

    emit!(BetPlaced {
        market: market.key(),
        bet: bet.key(),
        bettor: bet.bettor,
        side,
        stake,
        pool_yes: market.pool_yes,
        pool_no: market.pool_no,
    });

    Ok(())
}
