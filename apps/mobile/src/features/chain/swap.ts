/**
 * JUPITER AUTO-SWAP → USX.
 *
 * Turns "the user funded their wallet with whatever (SOL / USDC / an on-ramp
 * payout)" into "the user holds USX, the settlement asset". Quotes + builds the
 * swap on Jupiter's REST API, sends the returned VersionedTransaction through
 * the SAME sponsored Privy sender the rest of the chain layer uses, and confirms
 * it.
 *
 * HEAVY (pulls @solana/web3.js) — reach it ONLY via a dynamic `import('./swap')`
 * from inside useChain(), exactly like ./client and ./provider, so a screen that
 * never swaps never bundles it.
 *
 * REAL MONEY — the guards are not optional:
 *   • no Jupiter route        → throw (never silently burn the input);
 *   • price impact over cap   → throw (USX has depegged before — never swap into
 *                               a bad rate);
 *   • sponsored sends         → users do not need to keep SOL back for gas.
 */

import "./polyfills";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { usdFromBaseUnits, LAMPORTS_PER_SOL } from "./config";
import { explorerTxUrl, type ChainContext } from "./provider";

/** Native SOL wrapped-mint + USDC mainnet mint — the assets an on-ramp/transfer delivers. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** Jupiter free-tier host (no key). Swap to a paid `api.jup.ag` host if rate-limited. */
const JUPITER_BASE = "https://lite-api.jup.ag/swap/v1";

/** Keep a little SOL back for gas so a bet's self-paid fallback works even when Privy gas
 *  sponsorship is off/flaky. 0.01 SOL covers the one-time USX token-account rent (~0.002) plus
 *  ~hundreds of tx fees; the rest of a SOL deposit still converts to USX. (Previously 0 — which
 *  swapped away ALL SOL and left no gas, so bets failed when sponsorship didn't cover them.) */
const SOL_FEE_RESERVE_LAMPORTS = Math.round(0.01 * LAMPORTS_PER_SOL);
/** Keep USDC back so we can buy SOL for gas after the USX conversion (card deposits are USDC-only). */
const USDC_GAS_RESERVE_RAW = 2_000_000; // 2 USDC
/** Max USDC to spend topping up SOL when the wallet has none after deposit. */
const USDC_SOL_TOPUP_RAW = 2_000_000;
/** Below this, a token/SOL balance is dust — not worth a swap's fees. */
const MIN_SWAP_LAMPORTS = 0.003 * LAMPORTS_PER_SOL;
/** Reject a swap whose price impact exceeds this (USX depeg / thin-route protection). */
const MAX_PRICE_IMPACT_PCT = 3;
const DEFAULT_SLIPPAGE_BPS = 100; // 1.0%

export interface SwapResult {
  signature: string;
  explorerUrl: string;
  /** USX received, in display dollars (1 USX shown as $1). */
  outUsd: number;
  /** What was swapped in (for the receipt line). */
  inputMint: string;
}

/** One swappable, non-USX balance found in the wallet. */
export interface SwapCandidate {
  /** base58 mint. */
  mint: string;
  /** raw base units of THAT mint (lamports for SOL). */
  amount: number;
  /** "SOL" | "USDC" | a short mint label — for the UI. */
  label: string;
}

interface JupiterQuote {
  outAmount: string;
  priceImpactPct: string;
  routePlan?: unknown[];
  [k: string]: unknown;
}

const shortMint = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const labelFor = (mint: string): string =>
  mint === WSOL_MINT ? "SOL" : mint === USDC_MINT ? "USDC" : shortMint(mint);

/**
 * Enumerate everything in the wallet that is NOT already USX and is worth
 * swapping: SOL + every positive SPL token balance. The caller swaps each
 * candidate into USX.
 */
export async function findSwappableBalances(
  ctx: ChainContext,
): Promise<SwapCandidate[]> {
  const owner = ctx.wallet.publicKey;
  const usxMint = ctx.config.usxMint;
  const out: SwapCandidate[] = [];

  // Native SOL. Sponsored sends mean the user does not need to keep a fee reserve.
  const lamports = await ctx.connection.getBalance(owner, "confirmed");
  const swappableSol = lamports - SOL_FEE_RESERVE_LAMPORTS;
  if (swappableSol >= MIN_SWAP_LAMPORTS) {
    out.push({ mint: WSOL_MINT, amount: swappableSol, label: "SOL" });
  }

  // Every SPL token the wallet holds, except USX itself.
  const accounts = await ctx.connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID },
    "confirmed",
  );
  for (const { account } of accounts.value) {
    const info = account.data.parsed?.info;
    const mint: string | undefined = info?.mint;
    const raw: string | undefined = info?.tokenAmount?.amount;
    if (!mint || !raw || mint === usxMint) continue;
    const amount = Number(raw);
    if (amount <= 0) continue;
    const swappable =
      mint === USDC_MINT && amount > USDC_GAS_RESERVE_RAW
        ? amount - USDC_GAS_RESERVE_RAW
        : mint === USDC_MINT
          ? 0
          : amount;
    if (swappable > 0) out.push({ mint, amount: swappable, label: labelFor(mint) });
  }
  return out;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
): Promise<JupiterQuote> {
  const url =
    `${JUPITER_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${Math.floor(amount)}&slippageBps=${slippageBps}` +
    `&swapMode=ExactIn&restrictIntermediateTokens=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Couldn't price that swap (Jupiter ${res.status}).`);
  }
  const quote = (await res.json()) as JupiterQuote;
  if (!quote || !quote.routePlan || quote.routePlan.length === 0) {
    throw new Error(
      `No swap route to USX for ${labelFor(inputMint)} right now — your funds are safe; try again shortly.`,
    );
  }
  const impact = Math.abs(Number(quote.priceImpactPct ?? 0));
  if (impact > MAX_PRICE_IMPACT_PCT) {
    throw new Error(
      `Swap rate looks off (${impact.toFixed(1)}% price impact) — not converting to protect your funds.`,
    );
  }
  return quote;
}

async function buildSwapTx(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<string> {
  const res = await fetch(`${JUPITER_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true, // input SOL auto-wraps/unwraps WSOL
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Couldn't build that swap (Jupiter ${res.status}).`);
  const json = (await res.json()) as { swapTransaction?: string };
  if (!json.swapTransaction) throw new Error("Jupiter returned no swap transaction.");
  return json.swapTransaction;
}

async function sendSwapTx(
  ctx: ChainContext,
  vtx: VersionedTransaction,
): Promise<string> {
  if (ctx.wallet.sendSponsored) {
    try {
      const signature = await ctx.wallet.sendSponsored(
        Uint8Array.from(vtx.serialize()),
      );
      await ctx.connection.confirmTransaction(signature, "confirmed");
      return signature;
    } catch (e) {
      // Same graceful degrade as bets: sponsorship validates pre-broadcast, so fall back to a
      // self-paid send rather than hard-failing the deposit's auto-convert.
      console.warn("[chain] sponsored swap failed, falling back to self-paid:", e);
      try {
        return await ctx.provider.sendAndConfirm(vtx);
      } catch (e2) {
        console.warn("[chain] self-paid swap fallback failed:", e2);
        throw new Error("Swap didn't go through. Please try again.");
      }
    }
  }
  return ctx.provider.sendAndConfirm(vtx);
}

async function swapExactIn(
  ctx: ChainContext,
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  if (inputMint === outputMint) throw new Error("Same mint — nothing to swap.");
  const quote = await getQuote(inputMint, outputMint, amount, slippageBps);
  const swapB64 = await buildSwapTx(quote, ctx.wallet.address);
  const vtx = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(swapB64, "base64")),
  );
  const signature = await sendSwapTx(ctx, vtx);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature, ctx.config.cluster),
    outUsd: usdFromBaseUnits(Number(quote.outAmount)),
    inputMint,
  };
}

/**
 * Card/crypto deposits often leave 0 SOL (USDC-only). Keep ~0.01 SOL so bets and
 * withdrawals still work when Privy gas sponsorship is off or flaky.
 */
export async function ensureSolGasReserve(ctx: ChainContext): Promise<void> {
  const owner = ctx.wallet.publicKey;
  const lamports = await ctx.connection.getBalance(owner, "confirmed");
  if (lamports >= SOL_FEE_RESERVE_LAMPORTS) return;

  const accounts = await ctx.connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID },
    "confirmed",
  );
  let usdcRaw = 0;
  for (const { account } of accounts.value) {
    const mint: string | undefined = account.data.parsed?.info?.mint;
    const raw: string | undefined = account.data.parsed?.info?.tokenAmount?.amount;
    if (mint === USDC_MINT && raw) usdcRaw = Number(raw);
  }
  if (usdcRaw < 100_000) return;

  const amount = Math.min(usdcRaw, USDC_SOL_TOPUP_RAW);
  await swapExactIn(ctx, USDC_MINT, WSOL_MINT, amount);
}

/**
 * Swap `amount` raw base units of `inputMint` into USX. Quotes (guarding route +
 * price impact), builds, signs with the embedded wallet, sends + confirms.
 */
export async function swapToUsx(
  ctx: ChainContext,
  inputMint: string,
  amount: number,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapResult> {
  const outputMint = ctx.config.usxMint;
  return swapExactIn(ctx, inputMint, outputMint, amount, slippageBps);
}

/**
 * Convert the WHOLE wallet to USX: swap every non-USX balance (SOL above the fee
 * reserve + each SPL token) in turn. Returns a result per successful swap; a
 * per-asset failure (no route / bad rate / dust) is collected, never thrown, so
 * one bad asset can't strand the others. When nothing is swappable yet it returns
 * EMPTY (no throw) — so a deposit watcher can poll this safely until funds land;
 * empty candidates only do balance reads (no Jupiter call), so polling is cheap.
 */
export async function swapAllToUsx(
  ctx: ChainContext,
): Promise<{ swapped: SwapResult[]; failures: { label: string; reason: string }[] }> {
  const candidates = await findSwappableBalances(ctx);
  const swapped: SwapResult[] = [];
  const failures: { label: string; reason: string }[] = [];
  if (candidates.length === 0) return { swapped, failures };
  for (const c of candidates) {
    try {
      swapped.push(await swapToUsx(ctx, c.mint, c.amount));
    } catch (e) {
      failures.push({ label: c.label, reason: e instanceof Error ? e.message : "swap failed" });
    }
  }
  try {
    await ensureSolGasReserve(ctx);
  } catch (e) {
    failures.push({
      label: "SOL gas",
      reason: e instanceof Error ? e.message : "could not reserve SOL for fees",
    });
  }
  return { swapped, failures };
}

export { WSOL_MINT, USDC_MINT };
