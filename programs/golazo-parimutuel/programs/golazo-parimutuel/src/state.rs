//! On-chain account state and pure parimutuel math.
//!
//! The math here is the *integer mirror* of the off-chain reference in
//! `packages/core/src/parimutuel.ts`. Where the off-chain code uses floats in
//! the range 0..1 for `rake`, on-chain we use **basis points (bps, 1e4)** and
//! **u128 intermediates** so the result is
//! deterministic and never lossy in a way that loses lamports.

use anchor_lang::prelude::*;

use crate::errors::GolazoError;

/// Basis-points denominator. 10_000 bps == 100% == 1.0 in the off-chain floats.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// The two sides of a binary market.
///
/// Mirrors off-chain `Side = 'YES' | 'NO'`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Yes,
    No,
}

/// Lifecycle of a market.
///
/// `Open`   – accepting bets.
/// `Locked` – betting closed, awaiting the real-world result.
/// `Resolved` – settled to a Yes/No outcome; winners may claim.
/// `Void`   – cancelled; everyone may claim a full refund.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketStatus {
    Open,
    Locked,
    Resolved,
    Void,
}

/// The settled outcome.
///
/// `None` while unsettled. `Yes`/`No` once resolved. VOID is represented by
/// `MarketStatus::Void` (with `outcome == None`) so the void path and the
/// resolved path are unambiguous — this mirrors off-chain `Outcome` where
/// `'VOID'` is a distinct settlement branch, not a winning side.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    None,
    Yes,
    No,
}

/// PDA seeds: ["market", authority, market_seed].
///
/// Holds the pool accounting plus lifecycle. Lamports are NOT stored here — they
/// live in a dedicated, data-less, system-owned vault PDA (see `Vault` doc on
/// the accounts) so the market's own rent-exempt balance can never be confused
/// with bettor funds and so we can derive a clean signer for withdrawals.
#[account]
pub struct Market {
    /// The operator that may lock/resolve/void this market. Enforced via `has_one`.
    pub authority: Pubkey,
    /// Opaque per-market discriminator (e.g. a game_id-derived id). Part of the PDA seeds.
    pub market_seed: u64,
    /// keccak/sha hash of the human question ("Argentina — GOAL?"). Off-chain anchor only.
    pub question_hash: [u8; 32],
    /// Operator rake in basis points. Skimmed off the gross pool on settlement,
    /// regardless of outcome. Must be < 10_000.
    pub rake_bps: u16,
    /// Lifecycle state.
    pub status: MarketStatus,
    /// Settled side (None until Resolved).
    pub outcome: Outcome,
    /// Total lamports staked on YES.
    pub pool_yes: u64,
    /// Total lamports staked on NO.
    pub pool_no: u64,
    /// Optional original YES seed (normally zero in zero-capital mode).
    pub seed_yes: u64,
    /// Optional original NO seed (normally zero in zero-capital mode).
    pub seed_no: u64,
    /// Bump for the vault PDA (so we can sign vault withdrawals without re-finding it).
    pub vault_bump: u8,
    /// Bump for this market PDA.
    pub bump: u8,
}

impl Market {
    /// 8-byte Anchor discriminator + sum of field sizes.
    /// Pubkey(32) + u64(8) + [u8;32](32) + u16(2) + status enum(1) + outcome enum(1)
    /// + 4*u64(32) + 2*u8(2).
    pub const SIZE: usize = 8 + 32 + 8 + 32 + 2 + 1 + 1 + 32 + 2;

    /// gross = pool_yes + pool_no.  Mirrors off-chain `grossPool`.
    pub fn gross(&self) -> Result<u128> {
        (self.pool_yes as u128)
            .checked_add(self.pool_no as u128)
            .ok_or_else(|| error!(GolazoError::MathOverflow))
    }

    /// net = gross * (10_000 - rake_bps) / 10_000.  Mirrors off-chain `netPool`.
    ///
    /// Done entirely in u128. `rake_bps < 10_000` is enforced at init, so the
    /// `(10_000 - rake_bps)` term never underflows.
    pub fn net(&self) -> Result<u128> {
        let gross = self.gross()?;
        let keep_bps = BPS_DENOMINATOR
            .checked_sub(self.rake_bps as u128)
            .ok_or_else(|| error!(GolazoError::MathOverflow))?;
        gross
            .checked_mul(keep_bps)
            .ok_or_else(|| error!(GolazoError::MathOverflow))?
            .checked_div(BPS_DENOMINATOR)
            .ok_or_else(|| error!(GolazoError::MathOverflow))
    }

    /// Final winning-side pool after settlement.
    pub fn winning_pool(&self) -> Result<u128> {
        match self.outcome {
            Outcome::Yes => Ok(self.pool_yes as u128),
            Outcome::No => Ok(self.pool_no as u128),
            Outcome::None => err!(GolazoError::MarketNotSettled),
        }
    }
}

/// PDA seeds: ["bet", market, bettor].
///
/// One bet per (market, bettor). This keeps settlement O(1) per claimer and the
/// account model trivial. If a product wants multiple positions per user, mint a
/// fresh market or add a `nonce` seed — documented as a deliberate simplification.
#[account]
pub struct Bet {
    /// The market this bet belongs to (checked against the resolved market on claim).
    pub market: Pubkey,
    /// Who placed it; receives the payout/refund.
    pub bettor: Pubkey,
    /// Which side they backed.
    pub side: Side,
    /// Lamports staked.
    pub stake: u64,
    /// Double-spend guard: flipped true the first time this bet is claimed.
    pub claimed: bool,
    /// Bump for this bet PDA.
    pub bump: u8,
}

impl Bet {
    /// 8 discriminator + Pubkey(32) + Pubkey(32) + side enum(1) + u64(8)
    /// + bool(1) + u8(1).
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 1 + 1;

    /// Winner payout = stake / final_winning_pool * (gross - rake).
    pub fn parimutuel_payout(&self, market: &Market) -> Result<u64> {
        let won = matches!(
            (self.side, market.outcome),
            (Side::Yes, Outcome::Yes) | (Side::No, Outcome::No)
        );
        if !won {
            return Ok(0);
        }

        let winning_pool = market.winning_pool()?;
        if winning_pool == 0 {
            return Ok(0);
        }

        let payout = (self.stake as u128)
            .checked_mul(market.net()?)
            .ok_or_else(|| error!(GolazoError::MathOverflow))?
            .checked_div(winning_pool)
            .ok_or_else(|| error!(GolazoError::MathOverflow))?;
        u64::try_from(payout).map_err(|_| error!(GolazoError::MathOverflow))
    }
}
