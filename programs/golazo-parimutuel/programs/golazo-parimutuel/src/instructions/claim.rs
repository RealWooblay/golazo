//! `claim` — settle a single bet against the resolved/void market, in USX.
//!
//!   * VOID      -> refund exactly `stake`.
//!   * Resolved, bettor won  -> pay `stake / final_winning_pool * net_pool`.
//!   * Resolved, bettor lost -> pay 0 (still mark claimed so the Bet is closed).
//!
//! VAULT SIGNER SEEDS:
//! The vault is a PDA-owned USX token account whose token authority is the
//! Market PDA. To move USX OUT we CPI the SPL Token `transfer` with the Market
//! PDA as the signing authority — possible only because *this program* can
//! produce that PDA's signature via `invoke_signed` (Anchor's `with_signer`)
//! using the market seeds `["market", authority, market_seed, [bump]]`. No
//! private key exists for a PDA, so the pool is spendable only through this
//! program's logic.
//!
//! Because payouts are proportional to the final pool, total winner payouts can
//! never exceed the net pool, and `vault.amount` (USX) always covers them.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::GolazoError;
use crate::events::Claimed;
use crate::instructions::seeds;
use crate::state::{Bet, Market, MarketStatus, Outcome, Side};
use crate::USX_MINT;

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The bettor claiming. Must own the Bet PDA (enforced via `has_one`).
    #[account(mut)]
    pub bettor: Signer<'info>,

    /// The market this bet settled against. Must be Resolved or Void.
    #[account(
        seeds = [seeds::MARKET, market.authority.as_ref(), &market.market_seed.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// PDA-owned USX vault, validated by seeds + the bump stored on the market
    /// and pinned to the USX mint. Source of the payout/refund.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = USX_MINT,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Destination USX account for the payout. Must be the claimer's own USX
    /// account (mint-pinned, authority = bettor).
    #[account(
        mut,
        token::mint = USX_MINT,
        token::authority = bettor,
    )]
    pub bettor_token: Account<'info, TokenAccount>,

    /// The bet being claimed. Bound to (market, bettor) via seeds AND `has_one`,
    /// so a caller can neither claim someone else's bet nor a bet from a
    /// different market.
    #[account(
        mut,
        seeds = [seeds::BET, market.key().as_ref(), bettor.key().as_ref()],
        bump = bet.bump,
        has_one = bettor @ GolazoError::Unauthorized,
        has_one = market @ GolazoError::BetMarketMismatch,
    )]
    pub bet: Account<'info, Bet>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let market = &ctx.accounts.market;
    let bet = &mut ctx.accounts.bet;

    // --- Guards -----------------------------------------------------------
    // Must be settled one way or the other.
    require!(
        matches!(market.status, MarketStatus::Resolved | MarketStatus::Void),
        GolazoError::MarketNotSettled
    );
    // Double-spend guard. Flip it *before* paying so a re-entrant/duplicated
    // call in the same flow is impossible, and a later call simply errors.
    require!(!bet.claimed, GolazoError::AlreadyClaimed);
    bet.claimed = true;

    // --- Decide the amount ------------------------------------------------
    let (amount, refunded, won) = match market.status {
        MarketStatus::Void => {
            // VOID: full stake refund, no rake. Mirrors core's void branch.
            (bet.stake, true, false)
        }
        MarketStatus::Resolved => {
            let won = matches!(
                (bet.side, market.outcome),
                (Side::Yes, Outcome::Yes) | (Side::No, Outcome::No)
            );
            let amount = if won { bet.parimutuel_payout(market)? } else { 0 };
            (amount, false, won)
        }
        // Unreachable due to the guard above, but exhaustive for safety.
        _ => return err!(GolazoError::MarketNotSettled),
    };

    // --- Pay out from the vault (if anything is owed) ---------------------
    if amount > 0 {
        // `vault.amount` is the USX pool exactly (token-account rent is separate
        // SOL, not part of this balance). Total winner payouts are proportional
        // to the net pool, so this guard is a never-trip invariant in the normal
        // flow — it only fires on a transient shortfall. We HARD revert rather
        // than clamp: clamping would underpay the first claimer and strand the
        // rest, since `bet.claimed` flips regardless. Reverting rolls the whole
        // tx back (claimed is NOT persisted), so the client simply re-claims.
        require!(
            amount <= ctx.accounts.vault.amount,
            GolazoError::InsufficientVaultFunds
        );

        // Sign for the vault as the Market PDA (the vault's token authority).
        // These seeds MUST match the market PDA derivation, with the stored bump.
        let market_authority = market.authority;
        let market_seed_le = market.market_seed.to_le_bytes();
        let market_bump = market.bump;
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
                    to: ctx.accounts.bettor_token.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    emit!(Claimed {
        market: market.key(),
        bet: bet.key(),
        bettor: bet.bettor,
        amount,
        refunded,
        won,
    });

    Ok(())
}
