//! `close_market` — the market authority reclaims rent from a fully-settled,
//! fully-drained market by closing its USX vault + the Market account.
//!
//! SAFETY GATES (both required, checked in the handler):
//!   * status ∈ {Resolved, Void} — the market is settled, so it is no longer
//!     active (no new bets) and the payout/refund math is final.
//!   * vault.amount == 0 — every last USX has been claimed/refunded, so closing
//!     strands nobody's funds.
//!
//! With an empty vault there is no USX to lose. Closing returns BOTH SOL rents —
//! the vault token account's and the Market account's — to the authority
//! (operator). That is how the operator recovers the ~0.0038 SOL it paid to open
//! each market. An *active* market (Open/Locked) or one that still holds USX
//! (unclaimed payouts / refunds) is rejected: settle it and let bettors claim
//! first. The off-chain skip-list simply avoids *attempting* the ones that would
//! revert here — the on-chain gate is the actual guarantee.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};

use crate::errors::GolazoError;
use crate::events::MarketClosed;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus};
use crate::USX_MINT;

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    /// The market's creator. Signs, and receives BOTH reclaimed rents (the vault
    /// token account and the Market account).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The market being closed. `has_one = authority` (via the seeds using
    /// `authority.key()`) ensures only its creator can close it; `close =
    /// authority` returns its rent to the operator once the handler's gates pass.
    #[account(
        mut,
        seeds = [seeds::MARKET, authority.key().as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
        has_one = authority @ GolazoError::Unauthorized,
        close = authority,
    )]
    pub market: Account<'info, Market>,

    /// PDA-owned USX vault. Must be EMPTY (checked in the handler) before closing;
    /// its token authority is the Market PDA, so the close CPI is signed with the
    /// market seeds. Its reclaimed SOL rent goes to the authority.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = USX_MINT,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseMarket>) -> Result<()> {
    // --- Safety gates -----------------------------------------------------
    // Only a settled market can be closed; Open/Locked markets are still active.
    require!(
        matches!(
            ctx.accounts.market.status,
            MarketStatus::Resolved | MarketStatus::Void
        ),
        GolazoError::MarketNotSettled
    );
    // And only once every last USX has left the vault — otherwise closing would
    // strand unclaimed winner payouts / void refunds.
    require!(ctx.accounts.vault.amount == 0, GolazoError::VaultNotEmpty);

    // --- Close the (empty) vault token account, rent -> authority ---------
    // Signed by the Market PDA (the vault's token authority), with the stored bump.
    let market_authority = ctx.accounts.market.authority;
    let market_seed_le = ctx.accounts.market.market_seed.to_le_bytes();
    let market_bump = ctx.accounts.market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        seeds::MARKET,
        market_authority.as_ref(),
        &market_seed_le,
        &[market_bump],
    ]];

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer_seeds,
    ))?;

    // The Market account itself is closed by Anchor (`close = authority`) after
    // this handler returns, returning its rent to the operator too.
    emit!(MarketClosed {
        market: ctx.accounts.market.key(),
        authority: market_authority,
        market_seed: ctx.accounts.market.market_seed,
    });

    Ok(())
}
