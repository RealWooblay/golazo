//! `sweep_rake` — the withdraw authority collects a resolved market's operator
//! rake to its own USX account.
//!
//! The rake = `gross - net`. Sweeping exactly that leaves the vault holding `net`,
//! which is precisely the sum of all winner payouts — so the sweep is SAFE in any
//! claim order (early or late claimers are never short-changed). A `rake_swept`
//! flag makes it single-shot so a second call can't dip into the net pool.
//!
//! Only Resolved markets have rake (VOID refunds in full, no rake). Access is
//! gated to the hardcoded `WITHDRAW_AUTHORITY`, and the destination must be a USX
//! account that authority owns. The transfer is signed by the Market PDA (the
//! vault's token authority).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::GolazoError;
use crate::events::RakeSwept;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus};
use crate::{USX_MINT, WITHDRAW_AUTHORITY};

#[derive(Accounts)]
pub struct SweepRake<'info> {
    /// The one address allowed to withdraw rake (hardcoded program-wide).
    #[account(address = WITHDRAW_AUTHORITY @ GolazoError::Unauthorized)]
    pub withdraw_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// PDA-owned USX vault for this market, source of the rake.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = USX_MINT,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Destination for the rake — a USX account owned by the withdraw authority.
    #[account(
        mut,
        token::mint = USX_MINT,
        token::authority = withdraw_authority,
    )]
    pub treasury_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SweepRake>) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Resolved,
        GolazoError::MarketNotResolved
    );
    require!(!ctx.accounts.market.rake_swept, GolazoError::RakeAlreadySwept);
    // Flip before paying so a duplicated call in the same flow is impossible.
    ctx.accounts.market.rake_swept = true;

    let amount = ctx.accounts.market.rake_amount()?;
    if amount > 0 {
        require!(
            amount <= ctx.accounts.vault.amount,
            GolazoError::InsufficientVaultFunds
        );

        // Sign for the vault as the Market PDA (the vault's token authority).
        let market_authority = ctx.accounts.market.authority;
        let market_seed_le = ctx.accounts.market.market_seed.to_le_bytes();
        let market_bump = ctx.accounts.market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            seeds::MARKET,
            market_authority.as_ref(),
            &market_seed_le,
            &[market_bump],
        ]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(RakeSwept {
        market: ctx.accounts.market.key(),
        treasury: ctx.accounts.treasury_token.key(),
        amount,
    });

    Ok(())
}
