// NATIVE passthrough. Privy (and therefore its fiat on-ramp) is web-only in this
// repo — native uses the legacy embedded keypair and has no on-ramp. The web
// implementation lives in usePrivyOnramp.web.ts; Metro picks the right file by
// platform, so callers can import this unconditionally.
export interface PrivyOnrampOpenOpts {
  address: string;
  amountUsd?: number;
  method?: "card" | "stripe";
  provider?: "moonpay" | "coinbase";
  /** Fired when the user closes the on-ramp flow (settlement is async after this). */
  onExit?: () => void;
}

export interface PrivyOnramp {
  /** True only where the Privy on-ramp can actually run (web, signed in). */
  supported: boolean;
  stripeSupported: boolean;
  open: (opts: PrivyOnrampOpenOpts) => Promise<void>;
}

export function usePrivyOnramp(): PrivyOnramp {
  return {
    supported: false,
    stripeSupported: false,
    open: async () => {
      throw new Error("Card funding is available on the web app.");
    },
  };
}
