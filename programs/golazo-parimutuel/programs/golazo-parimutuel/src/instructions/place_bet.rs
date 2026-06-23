//! `place_bet` — back a side, deposit the USX stake, grow the selected pool.
//!
//! No payout is locked at bet time. Settlement later pays each winner their
//! proportional share of the final net pool. The stake is moved in USX from the
//! bettor's token account into the market's PDA-owned vault.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::GolazoError;
use crate::events::BetPlaced;
use crate::instructions::seeds;
use crate::state::{Bet, Market, MarketStatus, Side};
use crate::USX_MINT;

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    /// The bettor — signs, pays SOL rent for the Bet PDA, and funds the USX stake.
    #[account(mut)]
    pub bettor: Signer<'info>,

    /// The market being bet into. Must be Open (checked in the handler).
    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// PDA-owned USX vault for this market, validated by seeds + stored bump and
    /// pinned to the USX mint. Stakes are transferred in here.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = USX_MINT,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The bettor's USX account, source of the stake. Pinned to the USX mint and
    /// owned by the bettor (the token program enforces the signer can spend it).
    #[account(
        mut,
        token::mint = USX_MINT,
        token::authority = bettor,
    )]
    pub bettor_token: Account<'info, TokenAccount>,

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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, side: Side, stake: u64) -> Result<()> {
    // --- Guards -----------------------------------------------------------
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        GolazoError::MarketNotOpen
    );
    require!(stake > 0, GolazoError::ZeroStake);

    // --- Move the stake: bettor USX -> vault USX --------------------------
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.bettor_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.bettor.to_account_info(),
            },
        ),
        stake,
    )?;

    // --- NOW grow the side pool ------------------------------------------
    let market = &mut ctx.accounts.market;
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
