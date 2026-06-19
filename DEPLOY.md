# GOLAZO — devnet deploy (mirrors mainnet)

This gets GOLAZO live on **Solana devnet** so friends can open a link, fund a
devnet wallet in-app, and bet real (devnet) SOL — the same shape it would run on
mainnet. Three pieces: the **on-chain program** (done), the **feed service**
(operator + live match + market lifecycle), and the **web app**.

> Money model: real on-chain parimutuel via the deployed program. The program's
> vault PDA escrows bets and pays winners on claim — non-custodial. The feed runs
> the operator key (creates/locks/resolves markets) but never holds user funds.

---

## 1. On-chain program — ALREADY DEPLOYED ✅

- **Program id:** `GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu`
- **Cluster:** devnet · **Upgrade authority:** the deployer (`8yUZQG5sESz…`)
- Redeploy/upgrade after a program change:
  ```bash
  solana program deploy programs/golazo-parimutuel/target/deploy/golazo_parimutuel.so \
    --program-id programs/golazo-parimutuel/target/deploy/golazo_parimutuel-keypair.json \
    --url devnet
  ```
  (Needs ~3.7 devnet SOL on the configured deployer; `solana balance --url devnet`.)

## 2. Feed service (`services/feed`)

Node WS + HTTP server. It runs the live match, the AI market-maker, and the
**operator** that creates/locks/resolves the on-chain markets.

**Env (`services/feed/.env`, see `.env.example`):**
```
PORT=8787
FEED_MODE=espn               # real live match (falls back to sim if none live)
ESPN_LEAGUE=fifa.world       # or eng.1, etc.
CHAIN_ENABLED=1
SOLANA_RPC_URL=https://api.devnet.solana.com
GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu
OPERATOR_KEYPAIR=./operator-keypair.json   # gitignored; fund it on devnet
FEE_RECIPIENT=5kBBKSV2EUyLsa2sXoK9E1VVzmDXCaHnQiMfz8B8yJtP
ANTHROPIC_API_KEY=sk-ant-...               # gitignored; ROTATE the shared key
```

**Operator wallet** must hold devnet SOL (rent + tx fees for market lifecycle):
```bash
solana transfer <OPERATOR_PUBKEY> 1.5 --url devnet --allow-unfunded-recipient
```
Current operator `3Ye6ywk2nT3JmpxTpXT3Sd3zNeqwSkqQSFM2hSMkDc2M` is funded (1.5 SOL).

**Host it** (any Node host — Railway / Render / Fly):
- Start command: `npm i && npm run build -w @golazo/core && npm run dev -w @golazo/feed`
  (or compile feed to JS and `node dist/main.js`).
- Expose the port over **TLS** so the https web app can open `wss://` (browsers
  block `ws://` from an https page). Most hosts give you `wss://<app>.up.railway.app`
  automatically; otherwise put it behind an https reverse proxy.
- Health check: `GET /health` → `{ ok: true, clients: n }`.

## 3. Web app (`apps/mobile`, Expo web export)

```bash
EXPO_PUBLIC_FEED_URL=wss://<your-feed-host> \
EXPO_PUBLIC_CHAIN_ENABLED=1 \
EXPO_PUBLIC_SOLANA_CLUSTER=devnet \
EXPO_PUBLIC_GOLAZO_PROGRAM_ID=GicM38EbfZJ3azwbE34MPTFQgqQnxNyjrXPG9zr8Wbfu \
npx expo export -p web   # outputs apps/mobile/dist
```
Deploy `apps/mobile/dist` as a static site (Vercel / Netlify / Cloudflare Pages).
SPA rewrite: route all paths to `index.html` so deep links like `/join/ABCD` work.

> `app.json` already defaults to chain-on devnet + this program id, so the only
> thing a hosted build MUST add is **`EXPO_PUBLIC_FEED_URL`** (the app can't derive
> a feed host in a static deploy). Set it at export time as above.

## 4. Play with friends (the flow)

1. Open the deployed web URL → an embedded Solana wallet is auto-created.
2. **Fund it:** Wallet tab → "Fund (test SOL)" (devnet airdrop). Note: the public
   devnet faucet is rate-limited; if several friends airdrop at once, some will be
   throttled — the operator/deployer can `solana transfer` a little to tide them over.
3. Lobby → **Play with friends** → create a room → share the `/join/<CODE>` link.
4. Friends open the link, fund, join, and bet real devnet SOL per market; the
   leaderboard tracks each player; winners claim their pool share on-chain.

## Notes / hardening for mainnet (deferred)
- Rotate the ANTHROPIC key (it was shared once) and keep all keypairs gitignored.
- Mainnet = real money + licensing; not in scope here.
- A second device must reach the feed over the public `wss://` URL (LAN IP works
  for same-network testing).
