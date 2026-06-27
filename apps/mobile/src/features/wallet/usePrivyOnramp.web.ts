// WEB: Privy fiat on-ramp (MoonPay / Coinbase) straight into the user's embedded
// Solana wallet. The payout (SOL or USDC) lands in the wallet; the deposit flow
// then auto-swaps it to USX (see useChain.convertToUsx / features/chain/swap).
//
// Requires the provider(s) to be enabled in Privy Dashboard → Account Funding.
// onUserExited fires when the hosted widget closes — settlement is async AFTER
// that, so the caller polls the balance before swapping.
import { useCallback, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useFundWallet } from "@privy-io/react-auth/solana";

export interface PrivyOnrampOpenOpts {
  address: string;
  amountUsd?: number;
  provider?: "moonpay" | "coinbase";
  onExit?: () => void;
}

export interface PrivyOnramp {
  supported: boolean;
  open: (opts: PrivyOnrampOpenOpts) => Promise<void>;
}

export function usePrivyOnramp(): PrivyOnramp {
  const { authenticated, ready } = usePrivy();
  const onExitRef = useRef<(() => void) | undefined>(undefined);
  const { fundWallet } = useFundWallet({
    onUserExited: () => onExitRef.current?.(),
  });

  const open = useCallback(
    async (opts: PrivyOnrampOpenOpts) => {
      onExitRef.current = opts.onExit;
      // Cast the options bag: Privy's funding-option types shift across minor
      // versions; the runtime contract (cluster / amount / card provider) is
      // stable and documented. This path is web-runtime-verified, not type-proven.
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
    [fundWallet],
  );

  return { supported: ready && authenticated, open };
}
