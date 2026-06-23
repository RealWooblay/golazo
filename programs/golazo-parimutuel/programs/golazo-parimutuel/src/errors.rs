//! Program error codes.
//!
//! Every fallible invariant in the program maps to one of these. Keeping them
//! in one place makes the security surface easy to audit: each guard in the
//! instruction handlers references exactly one of these variants.

use anchor_lang::prelude::*;

#[error_code]
pub enum GolazoError {
    #[msg("Market is not Open for betting.")]
    MarketNotOpen,

    #[msg("Market must be Open or Locked for this action.")]
    MarketNotLockable,

    #[msg("Market is not in a state that can be resolved.")]
    MarketNotResolvable,

    #[msg("Market is not Resolved or Void yet; nothing to claim.")]
    MarketNotSettled,

    #[msg("This bet has already been claimed.")]
    AlreadyClaimed,

    #[msg("Signer is not the market authority.")]
    Unauthorized,

    #[msg("Arithmetic overflow / underflow.")]
    MathOverflow,

    #[msg("A bet already exists for this bettor on this market.")]
    BetExists,

    #[msg("Rake basis points must be in the range [0, 10000).")]
    InvalidRake,

    #[msg("Stake must be greater than zero.")]
    ZeroStake,

    #[msg("Resolve outcome must be Yes or No (use void_market for VOID).")]
    InvalidOutcome,

    #[msg("The provided bet does not belong to the resolved market.")]
    BetMarketMismatch,

    #[msg("Vault has insufficient lamports to cover this payout/refund.")]
    InsufficientVaultFunds,

    #[msg("Rake can only be swept from a Resolved market.")]
    MarketNotResolved,

    #[msg("Rake has already been swept for this market.")]
    RakeAlreadySwept,
}
