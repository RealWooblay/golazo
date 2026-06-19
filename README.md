# ⚡ GOLAZO — bet the play

Live, in-the-moment betting on **discrete game events**. While a match is on, the
feed/AI spots a "set" moment (a penalty, a corner, an attack launching) and opens a
short **YES/NO** market — *"Argentina on the attack — GOAL?"*. You tap a side, the
play happens, you get paid. Markets resolve in seconds, not weeks.

This repo is the working build of that idea: a real engine, a real-ish feed with an
AI watcher, a mobile app, and an on-chain settlement program.

---

## The one idea that makes it work

Two hard problems sank the naive version; both are solved here:

1. **Liquidity** — we do **not** use a bonding curve (it can't pay winners without
   "buyers after you"). We use a **parimutuel pool with a bet-time odds-lock**: all
   YES/NO stakes pool, the house takes a fixed rake, winners split the pool, and the
   multiple you see is **locked the instant you tap** so late money can't dilute you.
   → [`packages/core/src/parimutuel.ts`](packages/core/src/parimutuel.ts)

2. **Latency / fairness** — you bet on the **next** discrete event *before it happens*,
   and the betting window **locks before the play resolves**. At lock time nobody —
   not even someone on a faster feed — knows the outcome, so there's no edge to pick
   off. The result is shown via **tap-to-reveal** so a delayed TV is never spoiled.
   → [`packages/core/src/engine.ts`](packages/core/src/engine.ts), `watcher.ts`

---

## Architecture

```
            ┌─────────────────────── @golazo/core ───────────────────────┐
            │  types · parimutuel(+odds-lock) · MarketEngine · watcher · sim · protocol │
            └───────▲───────────────────▲──────────────────────▲─────────┘
                    │ imports           │ imports              │ mirrors math
        ┌───────────┴──────┐   ┌────────┴─────────┐   ┌────────┴──────────────┐
        │  apps/mobile      │   │  services/feed    │   │ programs/             │
        │  (Expo, iOS)      │◀──│  feed + AI watcher │   │  golazo-parimutuel    │
        │  offline OR  ws ──┼──▶│  ESPN→events→AI   │   │  (Anchor / Solana)    │
        │  live             │   │  →engine→WS+bots  │   │  on-chain settlement  │
        └───────────────────┘   └───────────────────┘   └───────────────────────┘

  feed event ──▶ watcher (AI or rules) ──▶ MarketTrigger ──▶ engine ──▶ Market ──▶ UI
```

Everything agrees on one set of types (`@golazo/core`), so the app, the service, and
the chain can't drift. The app runs **fully offline** on a simulated match, or
**live** against the service over WebSocket.

---

## Packages

| Path | What it is | Run / verify |
|------|------------|--------------|
| [`packages/core`](packages/core) | Framework-agnostic domain core: pool math, odds-lock, market state machine, feed types, match simulator. **Fully unit-tested.** | `npm test -w @golazo/core` |
| [`apps/mobile`](apps/mobile) | Expo + React Native (TypeScript) app, iOS-ready. Offline sim mode + live WS mode. | `npm run mobile` → press `i` |
| [`services/feed`](services/feed) | Node service: pulls a real ESPN feed, AI watcher (Claude) phrases bettable moments, drives the engine, broadcasts over WebSocket, bots fill pools. Degrades to sim + rules with zero config. | `npm run feed` |
| [`programs/golazo-parimutuel`](programs/golazo-parimutuel) | Anchor (Solana) program: on-chain parimutuel market + odds-lock that mirrors the core math exactly. | `anchor test` (needs toolchain) |
| [`index.html`](index.html) | The original single-file prototype (kept for reference). | open in a browser |

---

## Quick start

```bash
# 1. install everything (npm workspaces)
npm install

# 2. run the core tests (proves the pool math + odds-lock)
npm test

# 3a. play it offline — no backend needed
npm run mobile            # Expo dev server; press i for iOS simulator

# 3b. OR run the live service in another terminal, then point the app at it
npm run feed              # WebSocket on :8787, sim feed + rule watcher by default
#   set ANTHROPIC_API_KEY to enable the Claude AI watcher
#   set FEED_MODE=espn   to pull a real live match from ESPN
```

The Solana program builds separately (it needs the Solana CLI + Anchor):

```bash
cd programs/golazo-parimutuel && npm install && anchor build && anchor test
```

---

## Reading order (to understand the whole thing in ~20 min)

1. [`packages/core/src/parimutuel.ts`](packages/core/src/parimutuel.ts) — the mechanism, with comments
2. [`packages/core/src/engine.ts`](packages/core/src/engine.ts) — the market lifecycle
3. [`packages/core/src/watcher.ts`](packages/core/src/watcher.ts) — event → bettable market
4. [`apps/mobile/src/hooks/useGameFeed.ts`](apps/mobile/src/hooks/useGameFeed.ts) — the live loop on-device
5. [`services/feed/src/orchestrator.ts`](services/feed/src/orchestrator.ts) — the same loop, server-side, with the real feed + AI
6. [`programs/golazo-parimutuel/src/state.rs`](programs/golazo-parimutuel/programs/golazo-parimutuel/src/state.rs) — the same math, on-chain

---

## Status & honest notes

- **Built & verified:** the core engine (12 passing tests, strict typecheck), the
  service in sim mode, the app code & monorepo wiring.
- **Needs your toolchain:** the iOS simulator (Xcode) and the Anchor build (Solana CLI).
- **Deliberately out of scope for now:** the legal/licensing layer. The design assumes
  an offshore + crypto-rails route; that's a "later" problem we chose to defer.
- The "AI watching the game" is honest about what it does: it watches the structured
  **event/commentary stream**, not raw video — that's the fair, affordable version.
