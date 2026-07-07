# GOLAZO program — future improvements

Deferred hardening / features, in rough priority order. None block the current
mainnet test; they're for productionization.

## 1. Permissionless deadline-void (highest priority — user-funds safety)
**Problem:** if the operator never resolves *or* voids a market, bettors can
never `claim` — their USX is frozen in the vault forever (not stealable, but
stuck). There is no timeout / escape hatch today; recovery depends entirely on
operator liveness.

**Fix:** store a `resolve_by` unix timestamp on the Market at init, and add a
`void_after_deadline` instruction that **anyone** can call once `now > resolve_by`
on an un-settled market — flipping it to Void so everyone can refund without
trusting the operator to return. Keeps the no-trust guarantee for bettor
principal.

## 2. `close_market` (reclaim operator rent) — DONE
Implemented: `close_market` (authority-signed) closes the vault + Market accounts
and returns both SOL rents to the operator. Gated on `status ∈ {Resolved, Void}`
AND `vault.amount == 0`, so it can never touch user funds. Scripts:
`scripts/close-market.mjs` (single) and `scripts/close-all.mjs` (batch; dry-run by
default, writes `close-skiplist.json`). **Needs: program upgrade to mainnet + tests
before running.**

Two known limitations this surfaced, worth follow-up:
  * **Rounding dust strands a few markets.** The strict `vault.amount == 0` gate
    means a resolved two-sided market that retains parimutuel rounding dust (a few
    base units, sub-cent) can never be closed. Options: a dust-sweep path, or let
    close_market forward a sub-threshold residual to the authority before closing.
  * **Empty-but-Locked markets need a void first.** ~51 markets are stuck Locked
    with empty vaults (abandoned mid-lifecycle); they must be `void_market`'d
    (Open|Locked → Void) before close_market will accept them. The permissionless
    deadline-void in #1 would also clear these.

## 3. `settle_bet` push-crank (optional UX)
A permissionless `settle_bet(bet)` so the operator (or a bot) can push payouts +
close Bet accounts for users who don't claim themselves, then close the market.
Lets payouts be "pushed" instead of pull-claimed.

## 4. Batch sweeping
`sweep-all.mjs` sends one tx per market. Pack multiple `sweep_rake` instructions
per transaction (or use address-lookup tables) to cut tx count at scale.

## 5. Regenerate the IDL
`apps/mobile/src/features/chain/idl/golazo_parimutuel.ts` is stale (predates the
USX rework). It's currently vestigial — the client builds raw instructions and
doesn't use the Anchor `Program` for them — but regenerate it for hygiene.

## 6. Naming cleanup
On-chain u64 fields still use the `*Lamports` / `chainSeedLamports` suffix but now
hold USX base units. Rename for clarity (cascades through envs — do deliberately).
