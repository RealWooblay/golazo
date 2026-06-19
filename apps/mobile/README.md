# GOLAZO — mobile

The live **"bet the play"** app. While a match is live, the feed/AI spots a
discrete *set* moment (penalty, corner, free kick, an attack launching) and opens
a short YES/NO market — _"Argentina on the attack — GOAL?"_. You tap **YES** or
**NO**, the app shows an indicative payout estimate, betting closes a few seconds
**before** the play resolves, and the result is hidden behind **tap-to-reveal**
so it never spoils your delayed TV.

Built with **Expo (React Native) + expo-router + TypeScript (strict)**. All the
betting math lives in the shared **`@golazo/core`** workspace package — this app
is the UI + the device-side loop that drives it.

---

## Data flow (read this once and the whole app makes sense)

```
            ┌──────────── OFFLINE (default, no backend) ─────────────┐
            │                                                         │
 SimMatch ──┤ FeedEvent ─▶ watcher.triggerFromEvent ─▶ MarketEngine  │──▶ view model ─▶ UI
 (the feed) │           ╲                               .openMarket   │
            │            ╲─ outcomeFromEvent ─▶ engine.resolve        │
            │               (correlated by meta.sequenceId)          │
            └─────────────────────────────────────────────────────────┘

            ┌──────────────────── LIVE (WebSocket) ──────────────────┐
 feed svc ──┤ ServerMessage (game / commentary / market_*) ─▶ view model ─▶ UI
 :8787      │ tap ─▶ ClientMessage 'bet' ─▶ … ─▶ market_resolve credits you │
            └─────────────────────────────────────────────────────────┘
```

The single hook **`useGameFeed()`** runs whichever mode is selected and exposes
one flat view model (`game`, `commentary`, `market`, `pending`, `reveals`) plus
`placeBet` and `acknowledgeReveal` actions. If the live socket fails, it
**auto-falls back to OFFLINE** and surfaces a banner.

### The two timing rules that matter

1. **Lock before resolve.** Betting always closes (`engine.lock` at `market.lockAt`)
   a few seconds before the goal/miss event arrives — you can never bet on a
   moment that's already decided.
2. **Pure parimutuel settlement.** The quote at tap time is indicative. A win
   pays your proportional share of the frozen final net pool, so the operator
   never needs house capital to cover fixed odds.

---

## Folder map

```
apps/mobile/
├── app/                      # expo-router routes (file = screen)
│   ├── _layout.tsx           # providers (store, safe-area) + dark Stack nav
│   ├── index.tsx             # ★ the live Match screen — composes everything
│   ├── how-it-works.tsx      # plain-language explainer (modal)
│   └── settings.tsx          # offline/live toggle, live URL, reset balance (modal)
├── src/
│   ├── theme/                # color / spacing / typography tokens (mirror index.html)
│   ├── components/           # small, focused, documented UI pieces
│   │   ├── Scoreboard.tsx        # score + clock + pulsing LIVE dot
│   │   ├── CommentaryTicker.tsx  # single animated commentary line
│   │   ├── MarketCard.tsx        # idle / open / locked states of the market
│   │   ├── CountdownRing.tsx     # SVG ring; red in the last third
│   │   ├── OddsBar.tsx           # pool total + YES/NO split bar
│   │   ├── StakeChips.tsx        # $10 / $25 / $50 / $100 presets
│   │   ├── BetButtons.tsx        # YES (green) / NO (red) with live multiples
│   │   ├── RevealCard.tsx        # tap-to-reveal flip → WIN / MISS / VOID
│   │   ├── BetHistory.tsx        # "your bets" list
│   │   ├── BalanceHeader.tsx     # brand + nav links + balance pill
│   │   ├── Toast.tsx             # "Locked YES @ 3.48x" top toast
│   │   └── GoalFlash.tsx         # big "GOOOAL" celebration overlay
│   ├── hooks/
│   │   ├── useGameFeed.ts     # ★ the core loop (offline sim + live WS)
│   │   ├── useTick.ts         # one shared wall-clock heartbeat (drives the ring)
│   │   └── useBalance.ts      # balance selector over the store
│   ├── state/
│   │   ├── store.tsx          # React-Context store: balance, history, settings
│   │   └── types.ts           # UI view-model types (decoupled from the engine)
│   └── lib/
│       ├── ws.ts             # typed WebSocket client (protocol types from core)
│       ├── bots.ts          # simulated bettors that fill the pool over the window
│       ├── config.ts        # rake/seed/stakes + default live URL detection
│       └── format.ts        # money / odds formatting
├── app.json                  # Expo config (dark UI, scheme, expo-router plugin)
├── metro.config.js           # monorepo wiring (watch root, resolve hoisted deps)
├── babel.config.js           # babel-preset-expo + reanimated plugin (last)
└── tsconfig.json             # strict; @/* path alias → src/*
```

`@golazo/core` is consumed as **TypeScript source** (its `exports` point at
`src/index.ts`). `metro.config.js` watches the repo root so Metro can find and
transpile it — see the comments in that file.

---

## Run it

From the **repo root** (so npm workspaces hoist deps and link `@golazo/core`):

```bash
npm install          # once, at the repo root
npm run mobile       # = expo start in apps/mobile
# then press  i  for the iOS simulator  (or scan the QR with Expo Go)
```

Or directly:

```bash
cd apps/mobile
npx expo start       # press i / a / w
```

> Offline mode needs **zero backend** — a simulated match drives everything.

### Point it at a live feed

1. Start the feed service (defaults to `ws://<port 8787>`).
2. In the app: **Settings → Live feed = on**. The URL defaults to your dev
   machine on port `8787`; edit it if the service is elsewhere.
3. On a physical device, `localhost` won't reach your Mac — the default URL is
   derived from the Metro host so it resolves correctly. Override in Settings if
   needed.

If the socket can't connect (or drops), the app automatically falls back to the
offline simulator and shows a banner.

---

## Notes

- **Play money only.** Starting balance is $1,000; nothing real is ever wagered.
- **Strict TypeScript**, no `any`. Components are small and presentational; all
  economic logic stays in `@golazo/core`.
- Animations use **Reanimated** (reveal flip) and the built-in **Animated** API
  (ticker, toast, goal flash, LIVE dot) plus **react-native-svg** for the ring.
