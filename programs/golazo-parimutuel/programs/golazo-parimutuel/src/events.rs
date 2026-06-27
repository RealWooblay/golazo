//! Anchor events emitted for indexers and the GOLAZO app.
//!
//! These let the off-chain stack reconstruct full market state (and reconcile
//! against `@golazo/core`'s `settle()`) without polling account data.

use anchor_lang::prelude::*;

use crate::state::{Outcome, Side};

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub market_seed: u64,
    pub question_hash: [u8; 32],
    pub rake_bps: u16,
    pub seed_yes: u64,
    pub seed_no: u64,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bet: Pubkey,
    pub bettor: Pubkey,
    pub side: Side,
    pub stake: u64,
    /// Pool sizes AFTER this bet was added (so indexers can track live odds).
    pub pool_yes: u64,
    pub pool_no: u64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    /// `Yes`/`No` for a real result. For VOID, `voided == true` and `outcome == None`.
    pub outcome: Outcome,
    pub voided: bool,
    pub pool_yes: u64,
    pub pool_no: u64,
}

#[event]
pub struct RakeSwept {
    pub market: Pubkey,
    /// Destination USX token account (owned by WITHDRAW_AUTHORITY).
    pub treasury: Pubkey,
    /// USX base units swept (gross - net, incl. rounding dust).
    pub amount: u64,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub bet: Pubkey,
    pub bettor: Pubkey,
    /// USX base units paid out (winner payout, full refund on void, or 0 for a loser).
    pub amount: u64,
    /// True when this was a void refund rather than a resolved-market payout.
    pub refunded: bool,
    /// True when the bettor backed the winning side.
    pub won: bool,
}
