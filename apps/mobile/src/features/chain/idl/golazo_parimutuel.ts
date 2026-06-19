/**
 * HAND-AUTHORED IDL for the `golazo_parimutuel` Anchor program.
 *
 * This mirrors, byte-for-byte, the program in
 * `programs/golazo-parimutuel/programs/golazo-parimutuel/src/**` — the
 * instructions, their args/accounts, the `Market`/`Bet` accounts, and the
 * `Side`/`Outcome`/`MarketStatus` enums.
 *
 * WHY hand-authored (and how to replace it):
 *   The repo's Anchor program has not been `anchor build`-ed in this tree, so no
 *   generated `target/idl/golazo_parimutuel.json` exists yet. Rather than block
 *   the client, we keep a precise IDL here. After you run `anchor build`, copy
 *   the generated `target/idl/golazo_parimutuel.json` over this file's
 *   `IDL` constant (and `target/types/...ts` over `GolazoParimutuel`) and the
 *   typed client keeps working unchanged.
 *
 * SHAPE: Anchor 0.30.x IDL. `address` is the program id from `declare_id!`; the
 * Program client overrides it at runtime with the env-configured deployed id, so
 * the value here is only a default.
 *
 * NOTE on account ORDER: Anchor matches accounts positionally by the order in
 * each instruction's `accounts` array. These arrays follow the exact field order
 * of the `#[derive(Accounts)]` structs in the program, so the typed
 * `MethodsBuilder.accounts({...})` keys line up correctly.
 */

/** The TypeScript program type (Anchor 0.30 `Idl`-compatible literal type). */
export type GolazoParimutuel = {
  address: "Go1azoPariMutue11111111111111111111111111111";
  metadata: { name: "golazo_parimutuel"; version: "0.1.0"; spec: "0.1.0" };
  instructions: GolazoIdl["instructions"];
  accounts: GolazoIdl["accounts"];
  events: GolazoIdl["events"];
  errors: GolazoIdl["errors"];
  types: GolazoIdl["types"];
};

// The concrete IDL object. Typed as `const` so the client gets full inference.
export const IDL = {
  address: "Go1azoPariMutue11111111111111111111111111111",
  metadata: { name: "golazo_parimutuel", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "initialize_market",
      discriminator: [35, 173, 95, 233, 96, 142, 178, 235],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "market", writable: true },
        { name: "vault", writable: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "market_seed", type: "u64" },
        { name: "question_hash", type: { array: ["u8", 32] } },
        { name: "rake_bps", type: "u16" },
        { name: "seed_yes", type: "u64" },
        { name: "seed_no", type: "u64" },
      ],
    },
    {
      name: "place_bet",
      discriminator: [222, 62, 67, 220, 63, 166, 126, 33],
      accounts: [
        { name: "bettor", writable: true, signer: true },
        { name: "market", writable: true },
        { name: "vault", writable: true },
        { name: "bet", writable: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "side", type: { defined: { name: "Side" } } },
        { name: "stake", type: "u64" },
      ],
    },
    {
      name: "lock_market",
      discriminator: [253, 79, 215, 16, 109, 75, 16, 32],
      accounts: [
        { name: "authority", signer: true },
        { name: "market", writable: true },
      ],
      args: [],
    },
    {
      name: "resolve_market",
      discriminator: [155, 23, 80, 173, 46, 74, 23, 239],
      accounts: [
        { name: "authority", signer: true },
        { name: "market", writable: true },
      ],
      args: [{ name: "outcome", type: { defined: { name: "Outcome" } } }],
    },
    {
      name: "void_market",
      discriminator: [200, 51, 122, 179, 28, 67, 197, 240],
      accounts: [
        { name: "authority", signer: true },
        { name: "market", writable: true },
      ],
      args: [],
    },
    {
      name: "claim",
      discriminator: [62, 198, 214, 193, 213, 159, 108, 210],
      accounts: [
        { name: "bettor", writable: true, signer: true },
        { name: "market" },
        { name: "vault", writable: true },
        { name: "bet", writable: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: "Market", discriminator: [219, 190, 213, 55, 0, 227, 198, 154] },
    { name: "Bet", discriminator: [147, 226, 218, 11, 70, 243, 132, 30] },
  ],
  events: [
    { name: "MarketInitialized", discriminator: [0, 0, 0, 0, 0, 0, 0, 1] },
    { name: "BetPlaced", discriminator: [0, 0, 0, 0, 0, 0, 0, 2] },
    { name: "MarketResolved", discriminator: [0, 0, 0, 0, 0, 0, 0, 3] },
    { name: "Claimed", discriminator: [0, 0, 0, 0, 0, 0, 0, 4] },
  ],
  errors: [
    {
      code: 6000,
      name: "MarketNotOpen",
      msg: "Market is not Open for betting.",
    },
    {
      code: 6001,
      name: "MarketNotLockable",
      msg: "Market must be Open or Locked for this action.",
    },
    {
      code: 6002,
      name: "MarketNotResolvable",
      msg: "Market is not in a state that can be resolved.",
    },
    {
      code: 6003,
      name: "MarketNotSettled",
      msg: "Market is not Resolved or Void yet; nothing to claim.",
    },
    {
      code: 6004,
      name: "AlreadyClaimed",
      msg: "This bet has already been claimed.",
    },
    {
      code: 6005,
      name: "Unauthorized",
      msg: "Signer is not the market authority.",
    },
    {
      code: 6006,
      name: "MathOverflow",
      msg: "Arithmetic overflow / underflow.",
    },
    {
      code: 6007,
      name: "BetExists",
      msg: "A bet already exists for this bettor on this market.",
    },
    {
      code: 6008,
      name: "InvalidRake",
      msg: "Rake basis points must be in the range [0, 10000).",
    },
    { code: 6009, name: "ZeroStake", msg: "Stake must be greater than zero." },
    {
      code: 6010,
      name: "InvalidOutcome",
      msg: "Resolve outcome must be Yes or No (use void_market for VOID).",
    },
    {
      code: 6011,
      name: "BetMarketMismatch",
      msg: "The provided bet does not belong to the resolved market.",
    },
  ],
  types: [
    {
      name: "Side",
      type: { kind: "enum", variants: [{ name: "Yes" }, { name: "No" }] },
    },
    {
      name: "Outcome",
      type: {
        kind: "enum",
        variants: [{ name: "None" }, { name: "Yes" }, { name: "No" }],
      },
    },
    {
      name: "MarketStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "Open" },
          { name: "Locked" },
          { name: "Resolved" },
          { name: "Void" },
        ],
      },
    },
    {
      name: "Market",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "market_seed", type: "u64" },
          { name: "question_hash", type: { array: ["u8", 32] } },
          { name: "rake_bps", type: "u16" },
          { name: "status", type: { defined: { name: "MarketStatus" } } },
          { name: "outcome", type: { defined: { name: "Outcome" } } },
          { name: "pool_yes", type: "u64" },
          { name: "pool_no", type: "u64" },
          { name: "seed_yes", type: "u64" },
          { name: "seed_no", type: "u64" },
          { name: "vault_bump", type: "u8" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "Bet",
      type: {
        kind: "struct",
        fields: [
          { name: "market", type: "pubkey" },
          { name: "bettor", type: "pubkey" },
          { name: "side", type: { defined: { name: "Side" } } },
          { name: "stake", type: "u64" },
          { name: "claimed", type: "bool" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "MarketInitialized",
      type: {
        kind: "struct",
        fields: [
          { name: "market", type: "pubkey" },
          { name: "authority", type: "pubkey" },
          { name: "market_seed", type: "u64" },
          { name: "question_hash", type: { array: ["u8", 32] } },
          { name: "rake_bps", type: "u16" },
          { name: "seed_yes", type: "u64" },
          { name: "seed_no", type: "u64" },
        ],
      },
    },
    {
      name: "BetPlaced",
      type: {
        kind: "struct",
        fields: [
          { name: "market", type: "pubkey" },
          { name: "bet", type: "pubkey" },
          { name: "bettor", type: "pubkey" },
          { name: "side", type: { defined: { name: "Side" } } },
          { name: "stake", type: "u64" },
          { name: "pool_yes", type: "u64" },
          { name: "pool_no", type: "u64" },
        ],
      },
    },
    {
      name: "MarketResolved",
      type: {
        kind: "struct",
        fields: [
          { name: "market", type: "pubkey" },
          { name: "outcome", type: { defined: { name: "Outcome" } } },
          { name: "voided", type: "bool" },
          { name: "pool_yes", type: "u64" },
          { name: "pool_no", type: "u64" },
        ],
      },
    },
    {
      name: "Claimed",
      type: {
        kind: "struct",
        fields: [
          { name: "market", type: "pubkey" },
          { name: "bet", type: "pubkey" },
          { name: "bettor", type: "pubkey" },
          { name: "amount", type: "u64" },
          { name: "refunded", type: "bool" },
          { name: "won", type: "bool" },
        ],
      },
    },
  ],
} as const;

/** Convenience: the IDL's static type, used to type the Anchor `Program<...>`. */
type GolazoIdl = typeof IDL;
