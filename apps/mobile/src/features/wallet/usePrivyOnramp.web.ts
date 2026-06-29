// WEB: Privy fiat on-ramps into the user's embedded Solana wallet.
//
// Card funding goes through Privy's `useFiatOnramp` hook — Stripe Embedded
// Components (when enabled in Privy Dashboard) plus MoonPay/Coinbase fallbacks.
// Do NOT use the legacy `useFundWallet` MoonPay path for the primary button; that
// always opens MoonPay directly.
//
// Payout (USDC on Solana) is auto-swapped to USX via useChain.convertToUsx.
// Requires Account Funding enabled in Privy Dashboard + @stripe/crypto peer dep.
// Ensure Stripe embedded onramp can dynamic-import its peer dep (Privy loads this at checkout).
import "@stripe/crypto";
import { useCallback } from "react";
import { usePrivy, useFiatOnramp } from "@privy-io/react-auth";

/** Solana mainnet CAIP-2 — matches Privy `useFiatOnramp` docs (`solana:mainnet`). */
const SOLANA_DEST_CHAIN = "solana:mainnet";

export interface PrivyOnrampOpenOpts {
  address: string;
  amountUsd?: number;
  /** @deprecated All card flows use Privy fiat onramp now. */
  method?: "card" | "stripe";
  provider?: "moonpay" | "coinbase";
  onExit?: () => void;
}

export interface PrivyOnramp {
  supported: boolean;
  /** True when Privy fiat onramp is available (Stripe embedded if dashboard-enabled). */
  stripeSupported: boolean;
  open: (opts: PrivyOnrampOpenOpts) => Promise<void>;
}

export function usePrivyOnramp(): PrivyOnramp {
  const { authenticated, ready } = usePrivy();
  const { fund } = useFiatOnramp();

  const open = useCallback(
    async (opts: PrivyOnrampOpenOpts) => {
      await fund({
        source: {
          assets: ["usd"],
          defaultAsset: "usd",
        },
        destination: {
          asset: "usdc",
          chain: SOLANA_DEST_CHAIN,
          address: opts.address,
        },
        environment: "production",
        ...(opts.amountUsd && opts.amountUsd > 0
          ? { defaultAmount: String(opts.amountUsd) }
          : {}),
      });

      // Card payout (Stripe/MoonPay) settles USDC async — arm the Jupiter swap watcher.
      opts.onExit?.();
    },
    [fund],
  );

  return {
    supported: ready && authenticated && typeof fund === "function",
    stripeSupported: typeof fund === "function",
    open,
  };
}
