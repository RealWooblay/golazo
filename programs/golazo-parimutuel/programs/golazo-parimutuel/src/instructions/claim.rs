//! `claim` — settle a single bet against the resolved/void market.
//!
//!   * VOID      -> refund exactly `stake`.
//!   * Resolved, bettor won  -> pay `stake / final_winning_pool * net_pool`.
//!   * Resolved, bettor lost -> pay 0 (still mark claimed so the Bet is closed).
//!
//! VAULT SIGNER SEEDS:
//! The vault is a System-owned PDA at `["vault", market]`. To move lamports OUT
//! of it we must invoke the System Program `transfer` with the vault PDA as the
//! signer — which is only possible because *this program* can produce that PDA's
//! signature via `invoke_signed` (Anchor's `with_signer`) using the seeds
//! `["vault", market_key, [vault_bump]]`. No private key exists for a PDA, so
//! the vault funds are spendable *only* through this program's logic.
//!
//! Because payouts are proportional to the final pool, total winner payouts can
//! never exceed the net pool.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::GolazoError;
use crate::events::Claimed;
use crate::instructions::seeds;
use crate::state::{Bet, Market, MarketStatus, Outcome, Side};

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

    /// CHECK: lamport vault, validated by seeds + the bump stored on the market.
    #[account(
        mut,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

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

    pub system_program: Program<'info, System>,
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
        // `initialize_market` funds the vault to the rent-exempt minimum and
        // every stake lands in the vault, so post-init the vault holds exactly
        // `rent_min + gross` and `available` below equals the gross pool. Total
        // winner payouts can never exceed the net pool (<= gross), so this guard
        // is a never-trip invariant in the normal flow — it only fires if the
        // vault is *transiently* underfunded (e.g. a real-money bet still
        // propagating when the operator settled).
        //
        // We deliberately keep a HARD revert rather than clamping the payout to
        // `available` (`amount.min(available)`). Clamping would underpay whoever
        // claims first during a transient shortfall and permanently strand the
        // difference, because `bet.claimed` is flipped regardless of the amount
        // paid. Reverting instead rolls the whole tx back — `bet.claimed` is NOT
        // persisted — so the client (which already retries) simply re-claims
        // once the operator top-up lands, and no winner is ever short-changed.
        let rent_min = Rent::get()?.minimum_balance(0);
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let available = vault_lamports.saturating_sub(rent_min);
        require!(amount <= available, GolazoError::InsufficientVaultFunds);

        // Sign for the vault PDA. These seeds MUST match the `seeds=` on the
        // vault account above, with the stored bump appended.
        let market_key = market.key();
        let vault_seeds: &[&[u8]] = &[
            seeds::VAULT,
            market_key.as_ref(),
            &[market.vault_bump],
        ];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.bettor.to_account_info(),
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
