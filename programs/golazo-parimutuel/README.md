# GOLAZO — on-chain settlement layer (`golazo-parimutuel`)

A Solana **Anchor** program that settles GOLAZO live in-play YES/NO markets
on-chain with pure parimutuel payouts.

There is no house bank and no fixed odds guarantee. Every stake goes into the
market vault. After betting closes and the market resolves, winners split the
net pool in proportion to their stake on the winning side. The operator only
takes the configured rake on non-void settlements.

---

## Mechanism

- All YES + NO stakes form one gross pool.
- Optional seed may be deposited at market open, but production can use zero
  seed. Seed is accounting liquidity only; it is not required for solvency.
- The displayed quote is indicative: it estimates the payout if this bet lands
  and no later money arrives.
- Final payout is computed from the frozen final pools at claim time.
- A **VOID** refunds each bettor's stake with no rake.

This keeps total claims bounded by the vaulted pool, so the program never needs
operator capital to cover promised multiples.

---

## Bps Math

On-chain everything is integer **basis points (bps, 1e4)** with **u128**
intermediates. `rake_bps` is validated `< 10_000`.

```text
gross          = pool_yes + pool_no
net            = gross * (10_000 - rake_bps) / 10_000
winning_pool   = pool_yes if outcome=Yes else pool_no
winner_payout  = stake * net / winning_pool
```

| off-chain (`parimutuel.ts`) | on-chain (`state.rs`) |
| --- | --- |
| `grossPool(p)` | `Market::gross()` |
| `netPool(p, rake)` | `Market::net()` |
| `indicativeQuote(p, side, stake, rake)` | app/client bps quote helper |
| `settle(..., outcome)` | `claim()` proportional payout |
| `settle(..., 'VOID')` | `void_market` + `claim` refund |

### Worked Example

No seed, `rake = 500` bps (5%):

```text
Alice bets 50_000 YES
Bob   bets 50_000 NO

final pools: yes=50_000 no=50_000
gross=100_000
net=95_000

resolve YES:
Alice payout = 50_000 * 95_000 / 50_000 = 95_000
Bob payout   = 0
```

If more YES money arrives before lock, Alice's share is diluted because the
winning-side pool is larger. That is the zero-capital tradeoff.

---

## Account / PDA Model

| Account | Seeds | Owner | Purpose |
| --- | --- | --- | --- |
| `Market` | `["market", authority, market_seed]` | program | Pool accounting + lifecycle (`authority`, `market_seed`, `question_hash`, `rake_bps`, `status`, `outcome`, `pool_yes/no`, `seed_yes/no`, `vault_bump`, `bump`). |
| `Vault` | `["vault", market]` | System Program | Data-less lamport vault holding seed + stakes. |
| `Bet` | `["bet", market, bettor]` | program | One bet per (market, bettor): `side`, `stake`, `claimed`. |

The vault is a dedicated **data-less, system-owned PDA**. Deposits are System
Program transfers into the vault. Withdrawals are System transfers signed by the
vault PDA via `invoke_signed` with seeds `["vault", market, [vault_bump]]`.

---

## Instructions

| Instruction | Signer | State transition | Notes |
| --- | --- | --- | --- |
| `initialize_market` | authority | none -> **Open** | Creates Market + vault. Optional `seed_yes+seed_no` is deposited only when non-zero. |
| `place_bet` | bettor | requires **Open** | Moves stake to vault, grows the selected side pool, writes `Bet`. No fixed payout is stored. |
| `lock_market` | authority | **Open -> Locked** | Closes betting. |
| `resolve_market` | authority | **Open/Locked -> Resolved** | Outcome `Yes`/`No` only. |
| `void_market` | authority | **Open/Locked -> Void** | Everyone refunds their stake. |
| `claim` | bettor | requires **Resolved/Void** | Winner: `stake * net / final_winning_pool`; void: refund `stake`; loser: 0. Sets `claimed`. |

Events: `MarketInitialized`, `BetPlaced`, `MarketResolved`, `Claimed`.

---

## Security Notes

- **Authority gating** via `has_one = authority` + `Signer` on lock/resolve/void.
- **Status guards** on every transition (`MarketNotOpen`, `MarketNotResolvable`,
  `MarketNotSettled`).
- **Double-spend guard**: `claimed` is flipped before any lamports move.
- **PDA validation**: every account is `seeds`+`bump` constrained; `Bet` is bound
  to its `market`+`bettor`.
- **Checked arithmetic** everywhere (`checked_*`, u128 intermediates, narrowing
  via `try_from`) so overflow becomes `MathOverflow`.
- **Input validation**: `rake_bps < 10_000`, `stake > 0`.

Because payouts are proportional to the final net pool, total successful claims
cannot exceed the pool available to winners, aside from integer dust left in the
vault.

---

## Build & Test

> **Toolchain required.** You need the Solana CLI and Anchor toolchain (`avm` +
> `anchor-cli`, plus Rust) installed locally. This repo does not vendor them.

```bash
# from programs/golazo-parimutuel
npm install
anchor build
anchor keys sync
anchor test
```

`anchor test` spins up a local validator, deploys the program, and runs
`tests/golazo-parimutuel.ts` via `ts-mocha`.

### Mapping To `@golazo/core`

The on-chain `state.rs` math is the integer mirror of
`packages/core/src/parimutuel.ts`. The TS tests re-derive the same proportional
pool-share payout and assert the on-chain program matches.
