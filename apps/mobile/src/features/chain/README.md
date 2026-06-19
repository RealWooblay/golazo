# GOLAZO — on-chain layer (`src/features/chain`)

The **optional, lazy** Solana layer: an **embedded wallet** (no external wallet
app needed — Rainbet-style) plus a typed **Anchor client** for the
`golazo_parimutuel` program, wired so a bet / deposit / claim *can* be a real
Solana **devnet** transaction.

It is **off by default**. The app runs on Expo Web in sandbox / play-money mode
with zero backend and zero chain code in the bundle. On-chain mode only ever
loads `@solana/web3.js` / `@coral-xyz/anchor` when the user (or a screen)
explicitly calls `connect()`.

---

## TL;DR for callers

```ts
import { useChain } from '@/features/chain';

function GoOnChainButton() {
  const chain = useChain();              // loads NOTHING heavy on import
  // chain.ready === false until connect() succeeds → fall back to sandbox
  return <Button label="Go on-chain" onPress={() => chain.connect()} />;
}
```

When `connect()` succeeds, the embedded wallet's pubkey is **published into the
global store** (`wallet = { connected: true, walletKind: 'embedded', address }`),
so the wallet feature's `useDepositAddress()` automatically shows the real
address — the wallet screen never imports this feature or any chain lib.

---

## File map

| File | Heavy? | Role |
|---|---|---|
| `config.ts` | no | env-driven RPC / cluster / program id. `chainConfig.ok` gates everything. |
| `bps.ts` | no | the integer parimutuel quote math, mirror of the program's `state.rs`. |
| `types.ts` | no | type-only surface (`OnChainSide`, `MarketAccount`, `BetQuote`, …). |
| `pdas.ts` | **web3** | `findProgramAddressSync` for market / vault / bet PDAs. |
| `polyfills.ts` | **native** | `crypto.getRandomValues` + `Buffer`, imported only inside the heavy path. |
| `wallet.ts` | **web3** | the embedded `Keypair` — generate / persist / sign. Never exposes the secret. |
| `idl/golazo_parimutuel.ts` | no | hand-authored Anchor 0.30 IDL + program type. |
| `provider.ts` | **web3 + anchor** | builds `Connection` + `AnchorProvider` + typed `Program`. |
| `client.ts` | **web3 + anchor** | typed instruction helpers + account reads + airdrop. |
| `useChain.tsx` | no (lazy) | the React hook/context. Loads `provider`/`client` via dynamic `import()`. |
| `useChainDepositAddress.ts` | no (lazy) | the deposit-address hook the wallet feature consumes. |
| `index.ts` | no | barrel — re-exports ONLY the web-safe / lazy / type-only surface. |

> **Web-safety rule:** `index.ts` must never statically re-export `provider`,
> `client`, `wallet`, or `pdas` (all import web3 at module load). They are
> reached only through the dynamic `import()`s in `useChain().connect()`.

---

## The embedded wallet

Tap "go on-chain" and a Solana keypair just *exists* — there is no external app
to install.

- **Generated + persisted on first connect** (`EmbeddedWallet.loadOrCreate()`),
  idempotent on subsequent runs.
- **Storage is platform-aware** (behind a dynamic import, so nothing loads on the
  sandbox path):
  - **Native (iOS/Android):** the 64-byte secret key → `expo-secure-store`
    (Keychain / Keystore), encrypted at rest.
  - **Web:** SecureStore is unavailable → falls back to
    `@react-native-async-storage/async-storage` (localStorage). This is a
    **DEV / SANDBOX convenience only** — never put real value on a web-stored key.
- The secret key **never leaves `wallet.ts`**. The module exposes the address, an
  Anchor-compatible signer (`signTransaction` / `signAllTransactions`), a balance
  read, and a devnet airdrop — not the raw key.
- `EmbeddedWallet.destroy()` wipes the stored key ("reset wallet"). Irreversible;
  funds at the old address become unrecoverable (it's play money on devnet).

---

## Devnet setup (default)

Out of the box, `config.ts` targets **devnet** (`https://api.devnet.solana.com`),
but on-chain mode stays **unavailable** until you flip the enable flag *and* point
at a deployed program. This is intentional: the default experience is sandbox.

Env (via `process.env.EXPO_PUBLIC_*`, or `app.json` → `expo.extra`):

| Var | Values | Default | Meaning |
|---|---|---|---|
| `EXPO_PUBLIC_CHAIN_ENABLED` | `1` / `true` / `yes` | *(off)* | Master switch — required to even *attempt* on-chain mode. |
| `EXPO_PUBLIC_SOLANA_CLUSTER` | `devnet` / `testnet` / `mainnet-beta` / `localnet` | `devnet` | Picks the default RPC + gates the faucet. |
| `EXPO_PUBLIC_SOLANA_RPC_URL` | any RPC URL | *(per cluster)* | Override the RPC (e.g. a Helius / QuickNode devnet endpoint). |
| `EXPO_PUBLIC_GOLAZO_PROGRAM_ID` | base58 pubkey | *(placeholder)* | The deployed program id. Until set to a real key, `chainConfig.ok === false`. |

Example `.env` for a devnet demo:

```sh
EXPO_PUBLIC_CHAIN_ENABLED=1
EXPO_PUBLIC_SOLANA_CLUSTER=devnet
EXPO_PUBLIC_GOLAZO_PROGRAM_ID=<paste your deployed program id>
```

`resolveChainConfig()` never throws: if anything is missing/invalid it returns
`{ ok: false, reason }`, and `useChain()` reports `ready: false` so callers fall
back to sandbox.

---

## Deploying the program & pointing the app at it

The Anchor program lives at `programs/golazo-parimutuel` and ships with a
**placeholder** `declare_id!("Go1azo…")`. To run real transactions:

```sh
cd programs/golazo-parimutuel

# 1. Build + sync the real program id into declare_id! and Anchor.toml
anchor build
anchor keys sync          # prints the new program id

# 2. Fund the deployer + deploy to devnet
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet

# 3. Point the app at the deployed id
#    (use the program id anchor printed)
export EXPO_PUBLIC_GOLAZO_PROGRAM_ID=<that id>
export EXPO_PUBLIC_CHAIN_ENABLED=1
```

### Keep the IDL in sync

`idl/golazo_parimutuel.ts` is **hand-authored** to match the program byte-for-byte
because the tree has not been `anchor build`-ed yet. After your first build, copy
the generated artifacts over it:

```sh
# from programs/golazo-parimutuel after `anchor build`
cp target/idl/golazo_parimutuel.json  <somewhere>     # paste into IDL const
cp target/types/golazo_parimutuel.ts  <somewhere>     # paste GolazoParimutuel type
```

The client (`provider.ts`) overrides the IDL's `address` with the env-configured
program id at runtime, so the value baked into the IDL is only a default — you
don't have to edit it to repoint.

---

## The parimutuel math (parity with the program)

`bps.ts` is the **TypeScript mirror** of `programs/.../src/state.rs`. Everything
is `bigint` (mirroring the program's `u128`), in **basis points (1e4)**:

```text
gross          = pool_yes + pool_no
net            = gross * (10_000 - rake_bps) / 10_000
winning_pool   = final pool for the resolved winning side
winner_payout  = stake * net / winning_pool
```

`useChain().quoteBet(market, side, stakeLamports)` runs a stake-aware preview
with **no network**. It estimates the payout if this bet lands and no later money
arrives. The final claim payout floats with the pool until betting closes.

> **Note (auto-memory):** in the GOLAZO match UI, YES/NO odds are this
> parimutuel estimate — a directional payout, not a yield. Display it as an
> estimated multiple (`1.94x`) / implied odds, never as a projected APY.

---

## `useChain()` API

```ts
const chain = useChain();
```

| Field / method | Type | Notes |
|---|---|---|
| `ready` | `boolean` | **the fallback gate** — true only when fully connected. |
| `status` | `'idle' \| 'connecting' \| 'ready' \| 'error'` | |
| `reason` | `string?` | why unavailable / why a connect failed (debug). |
| `configured` | `boolean` | `chainConfig.ok` — is on-chain mode even allowed by env? |
| `address` | `string?` | embedded wallet pubkey (base58) once connected. |
| `balanceSol` / `balanceLamports` | `number` / `bigint` | embedded wallet SOL balance. |
| `cluster` | `Cluster` | resolved cluster (for labelling). |
| `airdropEnabled` | `boolean` | devnet faucet allowed? (gates the airdrop button). |
| `connect()` | `() => Promise<boolean>` | lazy-loads the stack, opens the wallet, publishes to the store. |
| `disconnect()` | `() => void` | reverts the store to the sandbox wallet (key is **not** destroyed). |
| `refreshBalance()` | `() => Promise<WalletInfo \| null>` | |
| `airdrop(sol)` | `=> Promise<TxResult>` | devnet faucet → embedded wallet (the simplest deposit). |
| `withdrawSol(to, sol)` | `=> Promise<TxResult>` | send SOL out of the embedded wallet (cash out). |
| `placeBetOnChain(args)` | `(PlaceBetArgs) => Promise<TxResult>` | real `place_bet` tx. |
| `claim(args)` | `(ClaimArgs) => Promise<TxResult>` | real `claim` tx. |
| `quoteBet(market, side, stake)` | `=> BetQuote` | pure bps preview, no network. |
| `fetchMarket(authority, seed)` | `=> Promise<MarketAccount \| null>` | decoded read. |
| `fetchBet(authority, seed, bettor?)` | `=> Promise<BetAccount \| null>` | decoded read (defaults to embedded wallet). |
| `derivePdas(authority, seed, bettor?)` | `=> MarketPdas` | market / vault / bet PDAs (base58). |
| `explorerAddressUrl(addr)` | `=> string` | cluster-aware explorer link. |
| operator: `initializeMarket / resolveMarket / lockMarket / voidMarket` | `=> Promise<TxResult>` | authority = embedded wallet; for devnet self-host / QA. |

`TxResult = { signature, explorerUrl }`. Where lamports/seeds are passed they
accept `bigint | number` and are converted to Anchor `BN` internally.

`PlaceBetArgs = { authority, marketSeed, side: 'Yes'|'No', stakeLamports }` —
`authority` + `marketSeed` are the market's PDA seeds; the embedded wallet is the
bettor.

### Mounting

Mount `ChainProvider` once, **inside** `StoreProvider` (so it can publish the
wallet to the store), above any `useChain()` consumer:

```tsx
<StoreProvider>
  <ChainProvider>          {/* autoConnect={false} by default */}
    {/* app */}
  </ChainProvider>
</StoreProvider>
```

If no `ChainProvider` is mounted, `useChain()` returns a stable **inert**
object with `ready: false` — so a pure web sandbox build can call `useChain()`
unconditionally and just see the fallback. `ChainProvider` also transparently
**reconnects** on mount if the store was persisted as an embedded wallet from a
prior session (so the address survives a reload). Pass `autoConnect` to connect
on mount even without a prior session.

---

## The deposit-address hook (wallet feature contract)

The wallet feature documents (in `features/wallet/address.ts`) that
`@/features/chain` exports a hook returning at least `{ ready, address? }`. That
hook is:

```ts
import { useChainDepositAddress } from '@/features/chain';

const { ready, address, balanceSol, cluster, explorerUrl, connect }
  = useChainDepositAddress();
```

It is a thin, type-only projection over `useChain()` — importing it pulls **no**
chain lib at module load. In practice the wallet's primary path reads the address
through the **store** (`useDepositAddress` → `wallet.address` when
`walletKind === 'embedded'`, populated by `connect()`); this direct hook is for
any chain-aware panel that wants the live pubkey + balance + a connect
affordance without going through the store.

---

## Security posture (read me)

- Secret key never leaves `wallet.ts`; only safe surfaces are exposed.
- On **web**, the key is in localStorage-backed AsyncStorage — **dev/sandbox
  only**, never real value. On **native** it's in the OS keychain.
- Vault withdrawals on-chain are signed by the program's PDA (no private key
  exists for it). Claims are proportional to the final pool, so successful
  payouts cannot exceed the vaulted funds aside from integer dust.
- This is **devnet / play money**. Do not point `EXPO_PUBLIC_SOLANA_CLUSTER` at
  `mainnet-beta` with real funds on a web-stored key.
