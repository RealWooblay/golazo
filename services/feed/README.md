# `@golazo/feed` — live-feed + AI watcher service

The realtime backend for GOLAZO ("bet the play"). While a match is live it:

1. **watches a feed** — a real ESPN game if one is live, otherwise a built-in simulator;
2. **lets an AI decide** which moments are bettable and phrases them (Claude, with a deterministic rule fallback);
3. **opens short YES/NO parimutuel markets** via the shared `@golazo/core` engine;
4. **fills the pools with bots** so they feel alive from the first bet;
5. **locks each market** a few seconds before the play resolves and **settles** it from the later goal/miss event (or VOIDs if no resolution arrives);
6. **broadcasts everything** to the mobile app over WebSocket.

Example market: **"Argentina on the attack — GOAL?"**

All domain logic (pool math, market state machine, the rule watcher, the simulator, the wire protocol) lives in `@golazo/core` — this service only orchestrates and serves.

---

## Architecture — follow the data

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                     orchestrator.ts                        │
  feed/ ── poll() ─▶│  for each FeedEvent:                                       │
  (sim | espn)      │    • broadcast commentary                                  │
        │           │    • attack-type "set moment"?                             │
        │           │        ai/watcher.ts (Claude) ─or─ core rule watcher       │
        │           │            └▶ MarketTrigger ─▶ engine.openMarket()         │
        │           │                 ├▶ bots.ts fills the pool over the window   │
        │           │                 └▶ auto-lock at market.lockAt              │
        │           │    • goal/miss?  correlate by meta.sequenceId ─▶ resolve() │
        │           │    • no resolution within timeout ─▶ VOID (refund)         │
        │           └───────────────┬──────────────────────────────────────────┘
        │                           │ engine.on(open|update|lock|resolve)
        ▼                           ▼
   GameState               server.ts  ── WebSocket broadcast ──▶  mobile app
                                      └─ HTTP GET /health, /state
```

Read `src/orchestrator.ts` first — it's the spine. Everything else is a leaf it calls.

| File | Responsibility |
|---|---|
| `src/config.ts` | Env-driven config with zero-config defaults. |
| `src/feed/index.ts` | `FeedSource` interface + factory (picks espn or sim by config + availability). |
| `src/feed/sim.ts` | Wraps core `SimMatch` as a feed source. |
| `src/feed/espn.ts` | Real ESPN feed → normalized `FeedEvent`s, with full error/fallback handling. |
| `src/ai/watcher.ts` | `aiTriggerFromEvents()` — Claude decides + phrases; falls back to core rules. |
| `src/bots.ts` | Simulated bettors that trickle real `placeBet` calls toward `trueProb`. |
| `src/orchestrator.ts` | Ties feed → watcher → engine → bots → broadcast; locks & resolves. |
| `src/server.ts` | WebSocket broadcast + HTTP `/health` and `/state`; accepts user `bet`s. |
| `src/main.ts` | Entry point. |

---

## Running

This is an npm-workspaces monorepo package (`services/feed`). From the **repo root**:

```bash
npm install          # installs all workspaces (run once)
npm run feed         # = npm run dev --workspace @golazo/feed
```

…or from inside the package:

```bash
cd services/feed
npm run dev          # tsx watch src/main.ts
```

With **zero configuration** this runs the **simulator feed + rule watcher + bots** on port `8787` — no API key, no network required. You'll see a market open within a few seconds, bots filling it, then a lock and a resolve.

Other scripts:

```bash
npm run typecheck    # tsc --noEmit (strict)
npm start            # tsx src/main.ts (no watch)
```

### Verify it's up

```bash
curl localhost:8787/health          # {"ok":true,"clients":0}
curl localhost:8787/state           # current game + open markets
```

---

## Environment variables

All optional — see `.env.example`. Defaults make `npm run dev` work with no config.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | WebSocket + HTTP port (the shared protocol default). |
| `ANTHROPIC_API_KEY` | _(unset)_ | If set, Claude is the watcher; if unset, the rule watcher is used. |
| `AI_MODEL` | `claude-haiku-4-5-20251001` | Fast model for the bettable-moment decision. |
| `AI_TIMEOUT_MS` | `2500` | Hard cap on the AI call before falling back to rules. |
| `FEED_MODE` | `auto` | `auto` (espn→sim), `sim` (always sim), `espn` (espn, sim if none live). |
| `ESPN_LEAGUE` | `eng.1` | ESPN soccer league slug (`eng.1`, `usa.1`, `esp.1`, …). |
| `ESPN_POLL_MS` | `8000` | ESPN summary poll interval while a game is live. |
| `RAKE` | `0.06` | Operator rake (house edge). |
| `BASE_SEED` | `12345` | Deterministic seed base. |
| `BOT_COUNT` | `24` | Bots filling each market's pool. |
| `RESOLVE_TIMEOUT_MS` | `30000` | If a locked market gets no resolution within this window, it VOIDs. |

---

## How the app connects

Connect a WebSocket to `ws://<host>:<PORT>` and exchange the protocol types from `@golazo/core` (`ServerMessage` / `ClientMessage`).

**Server → app** (`ServerMessage`):

```ts
{ t: 'game', game: GameState }                  // score / clock / status
{ t: 'commentary', text: string, ts: number }   // play-by-play
{ t: 'market_open', market: Market }            // a new bettable market
{ t: 'market_update', market: Market }          // pool / odds changed (a bet landed)
{ t: 'market_lock', market: Market }            // betting closed
{ t: 'market_resolve', market: Market }         // includes settlement w/ per-user payouts
```

**App → server** (`ClientMessage`):

```ts
{ t: 'hello', userId: string }
{ t: 'bet', marketId: string, side: 'YES' | 'NO', stake: number, userId: string }
```

On connect, the server immediately sends the current `game` frame and replays any **open** markets, so a late joiner can render and bet right away. A user `bet` goes through the **same** `engine.placeBet` path the bots use, so the user joins the real pool and locks their multiple at tap-time. When the market resolves, the `market_resolve` broadcast carries the full `settlement.payouts[]` (per `userId`), so the app can credit the user.

---

## ESPN endpoints + normalization

ESPN's free, unofficial, key-less JSON API:

1. **Scoreboard** — find a live game:
   `https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard`
   We pick the first event whose `status.type.state === 'in'` and read the two competitors (home/away, names, abbreviations, live score).

2. **Summary** — key plays + commentary for that event:
   `https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary?event={id}`
   We merge two arrays:
   - `keyEvents[]` — structured highlights (authoritative for goals/cards).
   - `commentary[]` — free-text play-by-play (mined only for build-up).

**Mapping ESPN → `FeedEventType`:**

| Source | Match | `FeedEventType` |
|---|---|---|
| keyEvent | `scoringPlay`, "Goal", "Penalty – Scored" | `goal` |
| keyEvent | "Penalty – Missed/Saved" | `miss` |
| keyEvent | "Penalty (awarded)" | `penalty` |
| keyEvent | "Yellow/Red Card" | `card` |
| keyEvent | "Corner" | `corner` |
| keyEvent | "Free kick / Foul" | `free_kick` |
| keyEvent | "Saved/Blocked/off the line" | `miss` |
| keyEvent | "Shot/Header/Attempt" | `shot` (or `miss` if off-target) |
| commentary | "dangerous", "through ball", "one-on-one", "counter", "breaks clear" | `dangerous_attack` |
| commentary | "into the box", "attack", "pressure", "building" | `attack` |

**Design rule:** goals/misses come from `keyEvents` only — free-text prose can **open** a market but never **decide** one. Every emitted event carries `meta.sequenceId` so an attack can be paired with the goal/miss that resolves it, exactly like the simulator.

**Resilience:** no live game, HTTP 4xx/5xx, `429` rate limits, timeouts, and malformed JSON are all handled as "no new events" — never a crash. The feed factory then falls back to the simulator. Uses global `fetch` (Node 18+).

---

## How the AI watcher fallback works

`aiTriggerFromEvents(recentEvents, gameState)` (in `src/ai/watcher.ts`):

- It watches the **structured event/commentary stream**, not raw video — its judgement is only as good as the text it's given.
- It only ever considers discrete **"set moments"** (`penalty`, `dangerous_attack`, `attack`, `corner`, `free_kick`); resolved events are never market openers.
- It forces **structured JSON** via a single tool (`emit_market_decision`) + `tool_choice` — there's no free-text to parse — then validates every field (types, finite numbers).
- It **caps latency** with a hard timeout (`AI_TIMEOUT_MS`), because opening a market is on the hot path.

It falls back to the deterministic `triggerFromEvent` from `@golazo/core` on **any** of:

- **missing `ANTHROPIC_API_KEY`** (no client is even constructed),
- a network / API error,
- a timeout,
- malformed or schema-invalid tool output,
- a `bettable: true` decision with no usable question/kind.

Either way the engine receives the **same `MarketTrigger` shape**, so it never knows whether a market was phrased by Claude or by the rules. If Claude returns `bettable: false`, no market opens — Claude can veto a moment the rules would have taken.

---

## Notes for the orchestrator running this

- **Do not edit anything outside `services/feed/`.** This package consumes `@golazo/core` as a workspace dep (`"@golazo/core": "*"`).
- `npm install` at the repo root installs all workspaces. `npm run dev` (sim mode, no env) is the smoke test; `npm run typecheck` runs `tsc --noEmit` (strict).
- No build step — `tsx` runs the TypeScript directly.
