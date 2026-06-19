import { useMemo } from "react";
import { useStore } from "@/state/store";
import { sandboxAddress } from "./address";

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

/**
 * useDepositAddress — the single source for the user's crypto deposit address,
 * resolved without ever hard-importing the Solana stack.
 *
 * Resolution order:
 *   1. If the store already carries a connected wallet address
 *      (`wallet.connected && wallet.address`), use it. This is how an embedded /
 *      connected wallet surfaces its pubkey to the rest of the app.
 *   2. Otherwise (SANDBOX / play-money default) derive a stable, demo base58
 *      address from the display name so the QR + copy flow works with zero
 *      backend.
 *
 * The chain feature is expected to populate `wallet.address` via the store when
 * on-chain mode is wired up; this hook intentionally reads it through the store
 * contract rather than importing `@/features/chain` directly, so a wallet screen
 * never pulls a chain lib at module load. `kind` tells the UI which label to show.
 */
export interface ResolvedAddress {
  address: string;
  kind: "embedded" | "sandbox";
  /** True when this is a real connected wallet (not a demo address). */
  live: boolean;
}

export function useDepositAddress(): ResolvedAddress {
  const { wallet, session } = useStore();

  return useMemo<ResolvedAddress>(() => {
    if (
      wallet.connected &&
      wallet.address &&
      wallet.walletKind === "embedded"
    ) {
      return { address: wallet.address, kind: "embedded", live: true };
    }
    return {
      address: sandboxAddress(session.displayName ?? "guest"),
      kind: "sandbox",
      live: false,
    };
  }, [
    wallet.connected,
    wallet.address,
    wallet.walletKind,
    session.displayName,
  ]);
}
