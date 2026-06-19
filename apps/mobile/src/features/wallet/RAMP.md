# Wallet — fiat on/off-ramp adapter

The wallet's "Add cash with card / Apple Pay" and "Cash out to card/bank" paths
talk to **one swappable interface** in front of a hosted fiat provider
(MoonPay / Transak / Coinbase Onramp). The UI never imports a provider SDK — it
only calls `getRamp()` and renders against the `RampAdapter` surface. Drop in a
real key and the same screens light up the live widget; with no key configured
they run a tasteful **sandbox** that simulates the purchase/payout and moves the
play-money balance.

> Default is sandbox. The app must render + work on Expo Web with zero backend,
> so the live provider is opt-in via config only.

---

## TL;DR — go live in one step

Add a provider key to `app.json` `extra` (or an `EXPO_PUBLIC_*` env var Metro
inlines). As soon as a key is present, `getRamp()` returns the live adapter and
`ramp.isLive === true`; the deposit/withdraw screens swap their copy from "Demo"
to the secure-provider language automatically.

```jsonc
// app.json
{
  "expo": {
    "extra": {
      "RAMP_PROVIDER": "moonpay",            // "moonpay" | "transak" | "coinbase" (default "moonpay")
      "MOONPAY_API_KEY": "pk_live_xxx",      // pk_test_xxx for staging
      "MOONPAY_BASE_URL": "https://buy.moonpay.com",   // optional override
      "MOONPAY_SELL_URL": "https://sell.moonpay.com",  // optional override
      "RAMP_DEFAULT_CURRENCY": "usd",        // optional, default "usd"
      "RAMP_CRYPTO": "sol"                   // settle asset, default "sol"
    }
  }
}
```

Per-provider key names the adapter looks up:

| Provider   | Key env name (under `extra` or `EXPO_PUBLIC_…`) |
|------------|-------------------------------------------------|
| `moonpay`  | `MOONPAY_API_KEY`                               |
| `transak`  | `TRANSAK_API_KEY`                               |
| `coinbase` | `COINBASE_APP_ID`                               |

Only MoonPay has a live adapter class today. A configured provider **without** a
wired live class falls back to sandbox (safe by default) — see "Adding a provider".

---

## The interface (`ramp.ts`)

```ts
interface RampAdapter {
  readonly provider: RampProvider;   // 'moonpay' | 'transak' | 'coinbase' | 'sandbox'
  readonly mode: RampMode;           // 'live' | 'sandbox'
  readonly isLive: boolean;          // true when real keys are present
  readonly fiatCurrency: string;     // 'usd'
  readonly cryptoCurrency: string;   // 'sol'
  buildBuyUrl(req: BuyRequest, sign?: RampSigner): Promise<RampUrl>;   // on-ramp
  buildSellUrl(req: SellRequest, sign?: RampSigner): Promise<RampUrl>; // off-ramp
}

getRamp(fresh?: boolean): RampAdapter   // memoised; pass true to bypass cache
isRampLive(): boolean                   // drives "demo" copy in the UI
```

`RampUrl` is `{ url, params, provider }` — the built widget URL **plus** the raw
param map, so a server-side signer can consume the params without re-deriving them.

---

## How the UI uses it (`useWallet.ts`)

`useWallet()` is the flow brain. It wraps the store's `deposit`/`withdraw` with a
local `flow` state (`idle → pending → success | error`) the screens animate off:

- **Sandbox** (`!ramp.isLive`, or `method === 'sandbox'`): a short pending beat,
  then `store.deposit()/store.withdraw()` and `success`. No network.
- **Live**: builds the widget URL via the adapter, opens it in the in-app browser
  (`openExternal`, web → new tab), and records the intent. **Settlement is
  confirmed by the provider redirect / webhook**, which belongs in `services/`,
  not this app — so the live path shows "finish in the secure window" guidance.

Crypto deposits use `useDepositAddress()` (reads the connected wallet pubkey from
the store contract, or a sandbox demo address) + a Solana Pay QR. Sandbox offers
a one-tap "simulate incoming" to demo the auto-credit.

---

## Production signing (the `RampSigner` seam)

Hosted widget URLs are normally signed by a backend holding the provider secret.
Inject a signer and the adapter hands it the unsigned `RampUrl`; whatever it
returns is used as the final URL. The UI never changes.

```ts
const signViaBackend: RampSigner = async ({ url, params }) => {
  const res = await fetch('https://api.golazo.app/ramp/sign', {
    method: 'POST',
    body: JSON.stringify({ url, params }),
  });
  const { signedUrl } = await res.json();
  return signedUrl;
};

// then, in useWallet (live branch):
const built = await ramp.buildBuyUrl(req, signViaBackend);
```

Keep the provider **secret** server-side. Only the publishable key (`pk_…` /
app id) belongs in the client config above.

---

## Adding a provider (Transak / Coinbase / …)

1. Implement a class with the `RampAdapter` interface in `ramp.ts` (mirror
   `MoonPayAdapter` — map `BuyRequest`/`SellRequest` to that provider's query params).
2. Add its key lookup in `resolveConfig()` (the table above).
3. Select it in the `getRamp()` factory when `cfg.provider === '<name>'` and a key
   is present.

No screen or component changes are required — they only depend on the interface.
