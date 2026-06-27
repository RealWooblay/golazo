// WEB: Privy fiat on-ramps into the user's embedded Solana wallet.
//   • method "card"   → MoonPay / Coinbase via useFundWallet (settles SOL/USDC to
//                       the wallet; onUserExited fires when the widget closes).
//   • method "stripe" → Privy fiat onramp via useFiatOnramp (delivers USDC).
// Either payout is then auto-swapped to USX (useChain.convertToUsx / chain/swap).
//
// Requires the matching provider enabled in Privy Dashboard → Account Funding.
// Settlement is async AFTER the flow closes, so callers poll the balance before
// swapping. (useFiatOnramp is @experimental in @privy-io/react-auth 3.32.1.)
import { useCallback, useRef } from "react";
import { usePrivy, useFiatOnramp } from "@privy-io/react-auth";
import { useFundWallet } from "@privy-io/react-auth/solana";

export interface PrivyOnrampOpenOpts {
  address: string;
  amountUsd?: number;
  /** "card" = MoonPay/Coinbase (useFundWallet); "stripe" = Privy fiat onramp. */
  method?: "card" | "stripe";
  provider?: "moonpay" | "coinbase";
  onExit?: () => void;
}

export interface PrivyOnramp {
  supported: boolean;
  /** True when the (experimental) Stripe path is present in this Privy build. */
  stripeSupported: boolean;
  open: (opts: PrivyOnrampOpenOpts) => Promise<void>;
}

export function usePrivyOnramp(): PrivyOnramp {
  const { authenticated, ready } = usePrivy();
  const onExitRef = useRef<(() => void) | undefined>(undefined);
  const { fundWallet } = useFundWallet({
    onUserExited: () => onExitRef.current?.(),
  });
  const fiat = useFiatOnramp();

  const open = useCallback(
    async (opts: PrivyOnrampOpenOpts) => {
      onExitRef.current = opts.onExit;

      if (opts.method === "stripe") {
        // Stripe → USDC to the wallet. fund() resolves when the flow completes, so
        // we trigger the swap after it resolves (no onUserExited on this surface).
        await fiat.fund({
          source: { assets: ["usd"] },
          destination: { asset: "USDC", chain: "solana:mainnet", address: opts.address },
          ...(opts.amountUsd && opts.amountUsd > 0
            ? { defaultAmount: String(opts.amountUsd) }
            : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        opts.onExit?.();
        return;
      }

      // MoonPay / Coinbase straight to the embedded wallet (onUserExited → onExit).
      await fundWallet({
        address: opts.address,
        options: {
          cluster: { name: "mainnet-beta" },
          ...(opts.amountUsd && opts.amountUsd > 0
            ? { amount: String(opts.amountUsd) }
            : {}),
          defaultFundingMethod: "card",
          card: { preferredProvider: opts.provider ?? "moonpay" },
          uiConfig: { receiveFundsTitle: "Add funds to GOLAZO" },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    },
    [fundWallet, fiat],
  );

  return {
    supported: ready && authenticated,
    stripeSupported: typeof fiat?.fund === "function",
    open,
  };
}
