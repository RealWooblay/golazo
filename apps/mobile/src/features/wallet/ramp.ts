import Constants from "expo-constants";

/**
 * FIAT ON/OFF-RAMP ADAPTER
 * ════════════════════════
 * One small, swappable interface in front of whatever hosted fiat provider we
 * use (MoonPay / Transak / Coinbase Onramp). The wallet UI only ever talks to
 * `getRamp()` — drop in real provider keys via config and the exact same screens
 * light up the real widget; with no keys we run a tasteful SANDBOX that simulates
 * the purchase/payout and credits the play-money store.
 *
 * ─── How to add real provider keys ───────────────────────────────────────────
 * Set these in app.json `extra` (or as EXPO_PUBLIC_* env vars Metro inlines):
 *
 *   extra: {
 *     RAMP_PROVIDER:    "moonpay" | "transak" | "coinbase",   // default "moonpay"
 *     MOONPAY_API_KEY:  "pk_live_xxx" | "pk_test_xxx",
 *     MOONPAY_BASE_URL: "https://buy.moonpay.com",            // optional override
 *     RAMP_DEFAULT_CURRENCY: "usd",                           // optional
 *     RAMP_CRYPTO: "sol",                                     // settle asset
 *   }
 *
 * As soon as a provider key is present, `getRamp()` returns the live adapter and
 * `ramp.mode === 'live'`. Until then it returns the sandbox adapter
 * (`ramp.mode === 'sandbox'`) and the UI shows a "demo" affordance.
 *
 * NOTE on signing: hosted widgets normally want a server-side URL signature for
 * production. That belongs in `services/` (not this app). The `buildBuyUrl` /
 * `buildSellUrl` here produce the *unsigned* widget URL + the exact param map a
 * signer would consume, and expose a `signUrl` seam (see `RampSigner`) so the
 * real signed URL can be injected without touching the UI.
 */

// ── Provider + currency types ────────────────────────────────────────────────

export type RampProvider = "moonpay" | "transak" | "coinbase" | "sandbox";
export type RampMode = "live" | "sandbox";

/** A request to BUY crypto with fiat (on-ramp / "Add cash"). */
export interface BuyRequest {
  /** Fiat amount the user wants to spend (in `fiatCurrency`). */
  fiatAmount: number;
  fiatCurrency: string; // 'usd'
  /** Settlement asset on Solana. */
  cryptoCurrency: string; // 'sol' | 'usdc_sol'
  /** Where settled crypto lands (the user's deposit address). */
  walletAddress: string;
  /** Optional: lock the widget to Apple Pay where the provider supports it. */
  preferredMethod?: "card" | "apple_pay";
  /** Deep link the provider returns to when the purchase completes. */
  redirectUrl?: string;
}

/** A request to SELL crypto for fiat (off-ramp / "Cash out"). */
export interface SellRequest {
  fiatCurrency: string;
  cryptoCurrency: string;
  /** Amount of crypto to sell, denominated in `cryptoCurrency`. */
  cryptoAmount: number;
  /** The user's wallet the funds debit from (for the widget context). */
  walletAddress: string;
  redirectUrl?: string;
}

/** The built widget URL + the raw params (handy for a server-side signer). */
export interface RampUrl {
  url: string;
  params: Record<string, string>;
  provider: RampProvider;
}

/**
 * Optional async signer seam. Production hosted-widget URLs are signed by a
 * backend with the provider secret. Inject one and the adapter will hand it the
 * unsigned URL + params and use whatever it returns. Absent → URL used as-is.
 */
export type RampSigner = (built: RampUrl) => Promise<string>;

/** The provider-agnostic surface the wallet UI builds against. */
export interface RampAdapter {
  readonly provider: RampProvider;
  readonly mode: RampMode;
  /** True when real keys are present and the live widget will open. */
  readonly isLive: boolean;
  /** Fiat currencies the widget supports (display only). */
  readonly fiatCurrency: string;
  readonly cryptoCurrency: string;
  /** Build the on-ramp (buy) widget URL. */
  buildBuyUrl(req: BuyRequest, sign?: RampSigner): Promise<RampUrl>;
  /** Build the off-ramp (sell / cash-out) widget URL. */
  buildSellUrl(req: SellRequest, sign?: RampSigner): Promise<RampUrl>;
}

// ── Config plumbing ──────────────────────────────────────────────────────────

interface RampConfig {
  provider: RampProvider;
  apiKey?: string;
  baseUrlBuy?: string;
  baseUrlSell?: string;
  fiatCurrency: string;
  cryptoCurrency: string;
}

function readEnv(key: string): string | undefined {
  const fromProcess =
    typeof process !== "undefined"
      ? (process.env?.[`EXPO_PUBLIC_${key}`] as string | undefined)
      : undefined;
  if (fromProcess && fromProcess.length > 0) return fromProcess;
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const v = extra[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveConfig(): RampConfig {
  const provider = (
    readEnv("RAMP_PROVIDER") ?? "moonpay"
  ).toLowerCase() as RampProvider;
  const fiatCurrency = (
    readEnv("RAMP_DEFAULT_CURRENCY") ?? "usd"
  ).toLowerCase();
  const cryptoCurrency = (readEnv("RAMP_CRYPTO") ?? "sol").toLowerCase();

  // Per-provider key lookup. Add the others as we wire them.
  const apiKey =
    provider === "moonpay"
      ? readEnv("MOONPAY_API_KEY")
      : provider === "transak"
        ? readEnv("TRANSAK_API_KEY")
        : provider === "coinbase"
          ? readEnv("COINBASE_APP_ID")
          : undefined;

  const baseUrlBuy =
    readEnv("MOONPAY_BASE_URL") ?? readEnv("RAMP_BASE_URL_BUY");
  const baseUrlSell =
    readEnv("MOONPAY_SELL_URL") ?? readEnv("RAMP_BASE_URL_SELL");

  return {
    provider,
    apiKey,
    baseUrlBuy,
    baseUrlSell,
    fiatCurrency,
    cryptoCurrency,
  };
}

function buildUrl(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

// ── MoonPay adapter (the default live provider) ──────────────────────────────

const MOONPAY_BUY = "https://buy.moonpay.com";
const MOONPAY_SELL = "https://sell.moonpay.com";

class MoonPayAdapter implements RampAdapter {
  readonly provider: RampProvider = "moonpay";
  readonly mode: RampMode = "live";
  readonly isLive = true;
  constructor(private cfg: RampConfig) {}

  get fiatCurrency() {
    return this.cfg.fiatCurrency;
  }
  get cryptoCurrency() {
    return this.cfg.cryptoCurrency;
  }

  async buildBuyUrl(req: BuyRequest, sign?: RampSigner): Promise<RampUrl> {
    const params: Record<string, string> = {
      apiKey: this.cfg.apiKey ?? "",
      currencyCode: req.cryptoCurrency,
      baseCurrencyCode: req.fiatCurrency,
      baseCurrencyAmount: String(req.fiatAmount),
      walletAddress: req.walletAddress,
    };
    if (req.preferredMethod === "apple_pay")
      params.paymentMethod = "mobile_wallet";
    if (req.preferredMethod === "card")
      params.paymentMethod = "credit_debit_card";
    if (req.redirectUrl) params.redirectURL = req.redirectUrl;

    const built: RampUrl = {
      provider: this.provider,
      params,
      url: buildUrl(this.cfg.baseUrlBuy ?? MOONPAY_BUY, params),
    };
    if (sign) built.url = await sign(built);
    return built;
  }

  async buildSellUrl(req: SellRequest, sign?: RampSigner): Promise<RampUrl> {
    const params: Record<string, string> = {
      apiKey: this.cfg.apiKey ?? "",
      baseCurrencyCode: req.cryptoCurrency,
      quoteCurrencyCode: req.fiatCurrency,
      baseCurrencyAmount: String(req.cryptoAmount),
      refundWalletAddress: req.walletAddress,
    };
    if (req.redirectUrl) params.redirectURL = req.redirectUrl;

    const built: RampUrl = {
      provider: this.provider,
      params,
      url: buildUrl(this.cfg.baseUrlSell ?? MOONPAY_SELL, params),
    };
    if (sign) built.url = await sign(built);
    return built;
  }
}

// ── Sandbox adapter (default when no keys) ───────────────────────────────────

/**
 * The sandbox doesn't open a real widget. Its `buildBuyUrl`/`buildSellUrl` return
 * an `about:blank#golazo-sandbox…` URL purely so the interface is uniform; the UI
 * detects `isLive === false` and runs the simulated pending→success flow that
 * credits/debits the play-money store directly.
 */
class SandboxAdapter implements RampAdapter {
  readonly provider: RampProvider = "sandbox";
  readonly mode: RampMode = "sandbox";
  readonly isLive = false;
  constructor(private cfg: RampConfig) {}

  get fiatCurrency() {
    return this.cfg.fiatCurrency;
  }
  get cryptoCurrency() {
    return this.cfg.cryptoCurrency;
  }

  async buildBuyUrl(req: BuyRequest): Promise<RampUrl> {
    const params = {
      sandbox: "1",
      flow: "buy",
      amount: String(req.fiatAmount),
      fiat: req.fiatCurrency,
      crypto: req.cryptoCurrency,
    };
    return {
      provider: this.provider,
      params,
      url: `about:blank#golazo-sandbox-buy`,
    };
  }

  async buildSellUrl(req: SellRequest): Promise<RampUrl> {
    const params = {
      sandbox: "1",
      flow: "sell",
      amount: String(req.cryptoAmount),
      fiat: req.fiatCurrency,
      crypto: req.cryptoCurrency,
    };
    return {
      provider: this.provider,
      params,
      url: `about:blank#golazo-sandbox-sell`,
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

let _cached: RampAdapter | null = null;

/**
 * Resolve the active ramp adapter (memoised). Live provider when a key is
 * configured, sandbox otherwise. Call `getRamp(true)` to bypass the cache (tests).
 */
export function getRamp(fresh = false): RampAdapter {
  if (_cached && !fresh) return _cached;
  const cfg = resolveConfig();

  // A key is required to go live; otherwise sandbox.
  const canGoLive = Boolean(cfg.apiKey) && cfg.provider !== "sandbox";

  let adapter: RampAdapter;
  if (canGoLive && cfg.provider === "moonpay") {
    adapter = new MoonPayAdapter(cfg);
  } else {
    // Transak/Coinbase live adapters slot in here as they're implemented; until
    // then any provider without a wired live class falls back to sandbox.
    adapter = new SandboxAdapter(cfg);
  }

  _cached = adapter;
  return adapter;
}

/** Convenience: is a real provider configured? Drives "demo" copy in the UI. */
export function isRampLive(): boolean {
  return getRamp().isLive;
}
