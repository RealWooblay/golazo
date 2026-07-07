//! Instruction handlers, one module per instruction.
//!
//! Each module exposes its `Accounts` context struct and a `handler` fn. The
//! top-level `lib.rs` `#[program]` module simply forwards to these handlers,
//! keeping the program entrypoint thin and the business logic unit-reviewable.

pub mod initialize_market;
pub mod place_bet;
pub mod lock_market;
pub mod resolve_market;
pub mod void_market;
pub mod claim;
pub mod sweep_rake;
pub mod close_market;

pub use initialize_market::*;
pub use place_bet::*;
pub use lock_market::*;
pub use resolve_market::*;
pub use void_market::*;
pub use claim::*;
pub use sweep_rake::*;
pub use close_market::*;

/// Canonical PDA seed prefixes. Centralized so every `seeds = [...]` constraint
/// and every client-side `findProgramAddress` agree byte-for-byte.
pub mod seeds {
    pub const MARKET: &[u8] = b"market";
    pub const VAULT: &[u8] = b"vault";
    pub const BET: &[u8] = b"bet";
}
