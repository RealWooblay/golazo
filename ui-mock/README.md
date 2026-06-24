# GOLAZO — UI mock

A **standalone, clickable visual prototype** of the new mobile UI direction. It is intentionally
**separate from the app** — no framework, no build step, no real data, not wired to the feed,
engine, or wallet. It exists only so we can iterate on look + flow without touching anything live.

## Run it

Just open the file — no server needed:

```
open ui-mock/index.html
```

…or serve the folder if you prefer a real URL:

```
cd ui-mock && python3 -m http.server 4321   # then visit http://localhost:4321
```

(View it in a mobile viewport / device-emulation for the intended size — it's a 380px phone frame.)

## What you can click

- **Onboarding** → "Play with points first" (or any sign-in icon) drops you into the lobby.
- **Lobby** → tap any live match card to enter its board.
- **Board** — the core loop, betting lives *on the board* (no modal, board never covered):
  - pick a stake on the bottom **stake console** (10 / 25 / 100),
  - tap a market side → the bet is placed inline with a 5-second **Undo** bar; let it run and it locks,
  - tap **Undo** to cancel,
  - tap **"simulate a result"** (top-right) to see the non-blocking win toast.
- **Bottom nav** → Live / Activity / Wallet.

## Files

| file | purpose |
|------|---------|
| `index.html` | the five screens (onboarding, lobby, board, activity, wallet) |
| `styles.css` | the design system — tokens + components (edit here to restyle) |
| `app.js`     | routing + the inline-bet / undo / stake interactions |

## Design language (tokens live in `styles.css :root`)

- Canvas `#0B0C0F`, surfaces `#15171C` / `#1E2128`, hairline `#23262D`
- One surgical accent `#27E08A` (LIVE, primary action, wins); danger `#FF5267` used sparingly
- Neutral team tints — home `#5B8DEF`, away `#F5A524` (contests read as A-vs-B, not right/wrong)
- Bold tabular numbers, generous dark space, no gradients / no glass

This is a throwaway prototype for direction-setting; the real implementation reskins the existing
`apps/mobile` components (`MarketCard`, `LockedStrip`, match header, `marketMeta`).
