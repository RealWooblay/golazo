//! `initialize_market` — create a Market + its USX token vault.
//!
//! VAULT MODEL (documented choice):
//! The vault is a **PDA-owned SPL token account** at seeds `["vault", market]`,
//! holding the USX stablecoin. Its token authority is the **Market PDA**, so:
//!   * Bettors deposit with a plain `token::transfer` into the vault (they sign
//!     as the source authority).
//!   * Payouts/refunds move USX out by a `token::transfer` signed by the Market
//!     PDA (`invoke_signed` with the market seeds) — see `claim.rs`. No private
//!     key exists for the PDA, so the pool is spendable only via this program.
//!
//! Unlike the old native-SOL design, a token account's **SOL rent is fully
//! separate from its token balance**. So `vault.amount` equals the pool exactly,
//! and there is no rent reservation that could bite into the prize pool. The
//! operator still pays the (one-time) SOL rent for the token account via `init`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::GolazoError;
use crate::events::MarketInitialized;
use crate::instructions::seeds;
use crate::state::{Market, MarketStatus, Outcome};
use crate::USX_MINT;

#[derive(Accounts)]
#[instruction(market_seed: u64)]
pub struct InitializeMarket<'info> {
    /// The operator. Pays SOL rent for the Market account and the vault token
    /// account, and funds any optional USX seed from `authority_token`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The market PDA. Seeds bind it to (authority, market_seed) so the same
    /// operator can run many markets and nobody can squat another's address.
    // Heavy `Account` types are `Box`ed onto the heap: this context has two
    // `init`s plus a `Mint` and two `TokenAccount`s, which together overflow the
    // SBF stack frame in `try_accounts` if kept inline.
    #[account(
        init,
        payer = authority,
        space = Market::SIZE,
        seeds = [seeds::MARKET, authority.key().as_ref(), &market_seed.to_le_bytes()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,

    /// The USX mint, pinned program-wide. `address = USX_MINT` makes it
    /// impossible to stand up a market vault for any other token.
    #[account(address = USX_MINT)]
    pub usx_mint: Box<Account<'info, Mint>>,

    /// PDA-owned USX vault for this market. Holds every stake; authority is the
    /// Market PDA so only this program (signing with the market seeds) can move
    /// funds out. Created here, paid by the operator.
    #[account(
        init,
        payer = authority,
        seeds = [seeds::VAULT, market.key().as_ref()],
        bump,
        token::mint = usx_mint,
        token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The operator's own USX account, source of any optional seed deposit. Even
    /// when the seed is zero (the normal zero-capital path) it must be a valid
    /// USX account owned by the authority; no USX is moved unless seed > 0.
    #[account(
        mut,
        token::mint = usx_mint,
        token::authority = authority,
    )]
    pub authority_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

    // --- Optional seed deposit: authority USX -> vault USX ----------------
    // Zero is the normal pure-parimutuel path. When nonzero the seed lands in
    // BOTH the vault (below transfer) AND the pools (state init below), keeping
    // `vault.amount == pool_yes + pool_no`. There is NO separate rent funding to
    // confuse with the seed — a token account's rent is paid in SOL by `init`
    // and never touches the token balance.
    if total_seed > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.authority_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
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
