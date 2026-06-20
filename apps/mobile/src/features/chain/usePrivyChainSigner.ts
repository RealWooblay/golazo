import type { PrivySignerState } from "./provider";

/**
 * Default / NATIVE: there is no Privy web SDK here, so the chain layer keeps
 * using the legacy locally-generated embedded keypair. (Native Privy via
 * @privy-io/expo is a later step.) The WEB override lives in `.web.ts`.
 */
export function usePrivyChainSigner(): PrivySignerState {
  return { mode: "legacy" };
}
