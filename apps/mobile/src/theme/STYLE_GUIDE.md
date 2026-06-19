# GOLAZO — Foundation Style Guide

The canonical reference for phase-2 feature agents. Everything below is built and
web-safe. **Compose, don't re-create.** Import tokens from `@/theme`, primitives
from `@/ui`, state from `@/state`.

Vibe: stadium-at-night. Premium crypto sportsbook. Confident, fast, tactile, a
little degen — refined, never garish. Accent + glow used **surgically** on
live/active states only.

---

## 1. Design tokens — `@/theme`

```ts
import { theme } from '@/theme';                  // the whole object
import { colors, type, spacing, radius, shadows, motion, gradients } from '@/theme';
```

### Colors (`colors`)
- **Canvas / elevation:** `bg` (#0a0b0f), `bgDeep`, `surface[0..3]` (indexable) +
  `surface0..surface3`. Surfaces are LAYERED, never flat — use `<Surface>`/`<Card>`.
- **Borders:** `hairline`, `hairlineSoft`, `topHighlight` (1px white top edge).
- **Text:** `textPrimary`, `textSecondary`/`textMuted` (#8b93a7), `textFaint`, `textGhost`.
- **Accents (semantic):** `primary`/`yes` (lime #00e58a), `secondary`/`cyan`/`info`
  (#16c6ff), `no`/`danger` (#ff4d6d), `gold`/`warning` (#ffc73a), `success`.
- **On-accent text:** `onPrimary`/`onYes`, `onGold`, `onNo`.
- **`colors.glow.*`** — rgba halos (`yes`, `yesSoft`, `no`, `cyan`, `gold`, …) for
  shadowColor / borders on live state.
- **`colors.alpha.*`** — translucent fills (`yes`, `no`, `cyan`, `gold`, `white06`,
  `white10`, `black40`, `black60`) for chips / selected states.
- **`colors.raw.*`** — literal hex escape hatch (gradient stops): `limeBright`,
  `limeDeep`, `cyan`, `cyanDeep`, `redBright`, `redDeep`, `gold`, `goldDeep`, `white`, …
- Legacy aliases (`accent`, `panel`, `txt`, `muted`, `line`, …) still exist — **do
  not use in new code.**

### Gradients (`gradients`)
Stop arrays for SVG / expo-linear-gradient: `canvas`, `card`, `cardElevated`,
`yes`, `no`, `gold`, `brand` (lime→cyan), `cyan`, `ringCalm`, `ringUrgent`,
`vignette`, `shimmer`.

### Typography (`type`, `fontFamily`, `fontSize`, …)
- **Display = Space Grotesk** (odds/scores/balances/questions, tabular numerals).
- **Body = Inter** (labels/copy/captions).
- Ready TextStyle presets: `type.hero | display | title | subtitle | body |
  bodyStrong | caption | overline | mono`. Compose: `[type.title, { color }]`.
- `tabularNumbers` — spread onto any animated number Text.
- `fontSize` scale: micro 10 · tiny 11 · caption 12 · small 13 · body 15 · md 16 ·
  lg 18 · xl 22 · xxl 28 · display 34 · hero 44 · goal 72.
- Font family keys (loaded in root layout): `SpaceGrotesk_500Medium/600SemiBold/
  700Bold`, `Inter_400Regular/500Medium/600SemiBold/700Bold`.

### Spacing / radii / layout (`spacing`, `radius`, `MAX_WIDTH`)
- `spacing`: none 0 · xxs 2 · xs 4 · sm 8 · md 12 · lg 16 · xl 20 · xxl 24 · xxxl 32 · huge 48.
- `radius`: xs 8 · sm 11 · md 14 · lg 18 · xl 24 · xxl 32 · pill 999.
- `MAX_WIDTH` 480 — cap the "app column" (Screen does this for you).
- `hitSlop`, `hairlineWidth`.

### Shadows (`shadows`)
`none · sm · md · lg` (soft, large-radius) + colored glows `glowYes · glowNo ·
glowCyan · glowGold · glowLive`. Web-safe (RN maps to boxShadow). Glow = live/active only.

### Motion (`motion` / `spring` / `duration` / `easing` / `pressScale`)
- `spring`: `press · entrance · bouncy · smooth · snappy · weighty`.
- `duration` (ms): instant 90 · fast 160 · base 240 · slow 360 · slower 520 ·
  pulse 600 · dot 1200 · shimmer 1400.
- `easing`: `out · in · inOut · overshoot · linear`.
- `pressScale`: subtle .98 · normal .96 · deep .94.

---

## 2. UI primitives — `@/ui`

All composable, documented in-file, web-safe (native-only modules lazy-required
with fallbacks). Interactive ones share spring press-depth + a haptic.

| Primitive | Key props |
|---|---|
| **Pressable** | `onPress`, `scaleTo=0.96`, `haptic='tap'\|null`, `enabledHaptics`, `disabled`, `style`, children |
| **Button** | `label`, `onPress`, `variant='primary'\|'secondary'\|'danger'\|'ghost'`, `size='sm'\|'md'\|'lg'`, `disabled`, `loading`, `fullWidth`, `glow?`, `haptic='select'`, `left`, `right` |
| **IconButton** | `children` (icon), `onPress`, `size=40`, `variant='surface'\|'ghost'`, `haptic`, `disabled`, `accessibilityLabel` |
| **Surface** | `children`, `radius=18`, `elevated?`, `glow='yes'\|'no'\|'gold'\|'cyan'`, `borderColor`, `style` |
| **Card** | Surface + `padding=16` + optional `onPress` (becomes Pressable). `radius`, `elevated`, `glow`, `borderColor`, `disabled` |
| **Sheet** | `open`, `onClose`, `children`, `snapPoints?`, `handle=true`, `contentStyle`. Native = @gorhom; web = spring-up + Blur fallback |
| **Chip** | `label`, `tone='live'\|'info'\|'win'\|'danger'\|'neutral'`, `dot?` (pulse), `selected?`, `onPress?`, `left?` |
| **AnimatedNumber** | `value`, `format:(n)=>string`, `spring=smooth` or `duration?` (timing), `style` (use a display/mono preset) |
| **ProgressBar** | `value` (0..1), `tone='yes'\|'no'\|'cyan'\|'gold'\|'split'`, `shimmer=true`, `height=10`, `width` (sweep px). `split` = YES/NO pool bar (value = YES share) |
| **Shimmer** | `width`, `height=8`, `running=true`, `opacity=0.14` (overlay; absolute) |
| **Skeleton** / **SkeletonGroup** | Skeleton: `width`, `height=14`, `radius`. Group: `lines=3`, `gap`, `lineHeight`, `lastLineWidth` |
| **Toast** | `message\|null` (controlled), `tone='info'\|'success'\|'danger'\|'gold'`, `durationMs=1900`, `onHide`. Top pill, springs in |
| **Banner** | inline notice: `tone`, `title?`, `message`, `left?`, `right?` |
| **Confetti** | `trigger` (bump to fire), `count=28`, `palette?`, `originX/Y?`. Lightweight reanimated burst (win) |
| **Divider** | `label?` (centered rule), `margin=16`, `inset=0` |
| **EmptyState** | `icon?` (emoji/node), `title`, `body?`, `ctaLabel?` + `onCta?` |
| **Text** | `preset` (type key, default 'body'), `color?`, `muted?`, `faint?`, `center?` + RN Text props |
| **GrainOverlay** | `opacity=0.04`, `baseFrequency=0.9` (on-top noise) |
| **Vignette** | `tint='yes'\|'no'\|'gold'\|'cyan'\|'neutral'`, `intensity=0.5`, `cx/cy/r` (behind hero) |
| **Blur** | `intensity=24`, `tint='dark'\|'light'`, children. expo-blur native / translucent web |
| **Screen** | page frame: `scroll=true`, `padded=true`, `vignette='neutral'`, `topInset=true`, `footerSpace=96` (clears tab bar) |
| **StubScreen** | placeholder a feature replaces: `title`, `owner`, `blurb?`, `tint?` |
| **TabBar** | wired in `(tabs)/_layout` via `tabBar={p => <TabBar {...p} />}` |

Helpers: `haptics` (`tap · select · selection · heavy · lock · win · lose · error`)
and `hapticIf(enabled, name)`. Icons (stroke, 24-grid): `IconPlay · IconWallet ·
IconProfile · IconBack · IconClose · IconPlus · IconArrowUp`.
App-shell: `GestureHandlerRootViewSafe`, `BottomSheetProviderSafe`, `useAppFonts`.

**Formatting** (`@/lib/format`): `money(n)` "$1,000" · `signedMoney(n)` "+$240" ·
`multiple(x)` "3.48x" · `pct(part, whole)`.

---

## 3. Store API — `@/state` (`useStore()`)

Single source of truth. React Context + reducer + AsyncStorage (hydrated on boot,
web-safe). `balance` is THE play-money number for both betting and wallet.

```ts
const store = useStore();
```

### State fields
- `balance: number`, `stake: number`, `liveUrl: string`, `hydrated: boolean`.
- `session: { firstRun, displayName?, mode: 'offline'|'live', soundOn, hapticsOn }`.
- `wallet: { connected, walletKind: 'sandbox'|'embedded', address? }`.
- `history: HistoryItem[]` (newest first; unified bets + transactions).
- Derived: `mode` (= session.mode), `bets: BetRow[]`, `transactions: TransactionRow[]`.

### Actions (exact signatures)
```ts
credit(amount: number): void                 // bet win / refund (no ledger row)
debit(amount: number): void                  // take a stake (clamps ≥ 0)
deposit(args: { amount: number; method: DepositMethod }): TransactionRow
withdraw(args: { amount: number; destination: WithdrawDestination }): TransactionRow
addBet(row: BetRow): void                     // append a settled bet to the ledger
addTransaction(row: TransactionRow): void
addHistory(row: HistoryRow): void             // @deprecated legacy bridge → addBet
setStake(stake: number): void
setMode(mode: 'offline' | 'live'): void
setName(name: string): void
setSession(session: Partial<Session>): void   // soundOn / hapticsOn / …
setWallet(wallet: Partial<Wallet>): void
setLiveUrl(url: string): void
completeFirstRun(): void                       // clears session.firstRun
reset(): void                                  // back to START_BALANCE, empty ledger
```

Money rules: `debit`/`credit` move balance for BETS (no row). `deposit`/`withdraw`
move balance AND append a `TransactionRow` atomically. Balance never goes negative.

### Exported types (`import type { … } from '@/state'`)
`Store`, `StoreState`, `Session`, `Wallet`, `DepositArgs`, `WithdrawArgs`,
`FeedMode`, `MarketPhase`, `MarketVM`, `PendingBet`, `RevealVM`,
`BetRow`, `TransactionRow`, `HistoryItem` (discriminate on `kind: 'bet'|'transaction'`),
`DepositMethod` ('sandbox'|'card'|'crypto'|'apple_pay'),
`WithdrawDestination` ('sandbox'|'bank'|'crypto'), `TransactionStatus`, `HistoryRow` (legacy).

**Match feed:** `useGameFeed()` (`@/hooks` or `@/features/match/useGameFeed`) →
`{ game, commentary, market, pending, reveals, effectiveMode, fallbackNotice,
placeBet(side, stake), acknowledgeReveal(marketId), toast, clearToast() }`.

---

## 4. Navigation map — `app/` (expo-router, typed routes)

```
app/_layout.tsx            Root: GestureRoot → SafeArea → Store → BottomSheetProvider.
                           Holds splash until fonts loaded AND store hydrated.
                           Dark Stack, slide_from_right (match = fade, onboarding = fade).

app/(tabs)/_layout.tsx     Custom blurred floating TabBar. Redirects to /onboarding on first run.
app/(tabs)/index.tsx       Play / Lobby            — OWNED BY: home agent
app/(tabs)/wallet.tsx      Wallet                  — OWNED BY: wallet agent
app/(tabs)/profile.tsx     Profile (+ settings)    — OWNED BY: profile agent

app/match/[id].tsx         Live match loop         — OWNED BY: match agent   (push: router.push(`/match/${id}`))
app/onboarding.tsx         First-run flow          — OWNED BY: home agent
app/(modals)/deposit.tsx   Deposit (modal)         — OWNED BY: wallet agent  (push: router.push('/(modals)/deposit'))
app/(modals)/withdraw.tsx  Withdraw (modal)        — OWNED BY: wallet agent
app/how-it-works.tsx       Explainer (modal)       — shared
```

Feature agents fill the route FILES only — **do not touch `_layout` files**. All
stubs use `<StubScreen>` and carry an `OWNED BY:` comment. Wrap real screens in
`<Screen>` so the canvas/grain/vignette/safe-area/app-column read identically.

---

## 5. Fonts

- **Display:** Space Grotesk (`@expo-google-fonts/space-grotesk`) — 500/600/700.
- **Body:** Inter (`@expo-google-fonts/inter`) — 400/500/600/700.
- Loaded via `useAppFonts()` in the root `BootGate`; splash held until ready.

---

## 6. Web-safety contract (every agent)

The app MUST render on Expo Web (we verify via screenshots). So:
- Never hard-import a native-only / chain lib at module load. Lazy-`require()`
  behind try/catch with a fallback (see `Blur`, `Sheet`, `GestureRoot`,
  `BottomSheetProvider`).
- Sandbox / play-money mode is the default and works with zero backend.
- Use SVG (`react-native-svg`, installed) for gradients/grain over hard deps where practical.

---

## 7. Dependencies added (not installed — single install happens later)

`expo-haptics`, `expo-blur`, `expo-linear-gradient`, `expo-image`, `expo-font`,
`expo-web-browser`, `expo-splash-screen`, `@react-native-async-storage/async-storage`,
`react-native-gesture-handler`, `@gorhom/bottom-sheet`,
`@expo-google-fonts/space-grotesk`, `@expo-google-fonts/inter`.
Chain (added now so package.json isn't re-touched): `@solana/web3.js`,
`@coral-xyz/anchor`, `@solana/spl-token`, `expo-secure-store`,
`react-native-get-random-values`, `buffer`.
