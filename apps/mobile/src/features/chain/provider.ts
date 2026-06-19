/**
 * CONNECTION / ANCHOR-PROVIDER FACTORY — the single place that constructs the
 * heavy Solana objects (`Connection`, `AnchorProvider`, `Program`) for the
 * embedded wallet.
 *
 * EVERYTHING in this file pulls in `@solana/web3.js` / `@coral-xyz/anchor` /
 * the keypair (`./wallet`) / the polyfills, so it MUST only ever be reached
 * through a dynamic `import('./provider')` from inside `useChain()`. A screen
 * that never turns on on-chain mode never bundles any of it.
 *
 * Lifecycle:
 *   buildChainContext()  → loads/creates the embedded wallet, opens a devnet (or
 *                          configured) Connection, builds an AnchorProvider, and
 *                          instantiates the typed Program from the local IDL with
 *                          the env-configured program id. Returns a ChainContext
 *                          that the client helpers operate on.
 *
 * The factory NEVER throws to its caller: any failure (bad RPC, bad program id,
 * storage error) is caught and surfaced as `{ ok: false, reason }`, so
 * `useChain()` can cleanly report `ready=false` and the app falls back to
 * sandbox. This is the web-safety / graceful-degradation contract.
 */

import "./polyfills"; // crypto.getRandomValues + Buffer — before any web3 usage

import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
  setProvider,
} from "@coral-xyz/anchor";
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";

import { chainConfig, type ChainConfig } from "./config";
import { IDL } from "./idl/golazo_parimutuel";
import { EmbeddedWallet } from "./wallet";

/** Confirmation level for reads + tx confirmation. `confirmed` is the sweet spot. */
const COMMITMENT: Commitment = "confirmed";

/**
 * The live, heavy chain handle. Held by `useChain()` for the duration of an
 * on-chain session and passed to every client helper. Constructed once via
 * {@link buildChainContext}.
 */
export interface ChainContext {
  config: ChainConfig;
  connection: Connection;
  wallet: EmbeddedWallet;
  provider: AnchorProvider;
  /**
   * Anchor program client, pointed at the configured program id. Typed as the
   * generic `Program<Idl>` — our hand-authored IDL is a `readonly` const literal
   * which doesn't satisfy the mutable `Idl` constraint for the typed generic, so
   * we keep the namespaces string-indexed and resolve instruction/account names
   * by their IDL strings (snake_case) in `client.ts`.
   */
  program: Program<Idl>;
  programId: PublicKey;
}

export type BuildResult =
  | { ok: true; context: ChainContext }
  | { ok: false; reason: string };

/**
 * Construct the full chain context (connection + embedded wallet + Anchor
 * program). Returns a discriminated result instead of throwing so the caller
 * can degrade to sandbox cleanly.
 */
export async function buildChainContext(): Promise<BuildResult> {
  // Gate on the eagerly-resolved config. If on-chain mode isn't configured we
  // never touch the network or storage.
  if (!chainConfig.ok) {
    return {
      ok: false,
      reason: chainConfig.reason ?? "On-chain mode is not configured.",
    };
  }

  try {
    const programId = new PublicKey(chainConfig.programId);

    // Embedded wallet (generated + persisted on first run). May hit secure
    // storage; wrapped in the outer try so a storage fault degrades gracefully.
    const wallet = await EmbeddedWallet.loadOrCreate();

    const connection = new Connection(chainConfig.rpcUrl, {
      commitment: COMMITMENT,
    });

    // AnchorProvider binds the connection + our embedded signer. `skipPreflight`
    // is left default (false) so we get useful simulation errors back.
    const provider = new AnchorProvider(
      connection,
      wallet.anchorWallet as unknown as Wallet,
      {
        commitment: COMMITMENT,
        preflightCommitment: COMMITMENT,
      },
    );
    // Make this the ambient provider so any bare Program() calls resolve it too.
    setProvider(provider);

    // Anchor 0.30: Program(idl, provider). The program id comes from the IDL's
    // `address`, so we clone the IDL with the env-configured id baked in — this
    // is how we repoint at a freshly-deployed program without editing the IDL.
    const idlWithAddress = {
      ...(IDL as unknown as Idl),
      address: programId.toBase58(),
    };
    const program = new Program(idlWithAddress as Idl, provider);

    return {
      ok: true,
      context: {
        config: chainConfig,
        connection,
        wallet,
        provider,
        program,
        programId,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason:
        e instanceof Error
          ? e.message
          : "Failed to initialize the chain context.",
    };
  }
}

/** Cluster-aware Solana Explorer URL for a tx signature (used on receipts). */
export function explorerTxUrl(
  signature: string,
  cluster: ChainConfig["cluster"],
): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  // mainnet-beta needs no cluster param; everything else does.
  if (cluster === "mainnet-beta") return base;
  const clusterParam = cluster === "localnet" ? "custom" : cluster;
  return `${base}?cluster=${clusterParam}`;
}

/** Cluster-aware Solana Explorer URL for an address. */
export function explorerAddressUrl(
  address: string,
  cluster: ChainConfig["cluster"],
): string {
  const base = `https://explorer.solana.com/address/${address}`;
  if (cluster === "mainnet-beta") return base;
  const clusterParam = cluster === "localnet" ? "custom" : cluster;
  return `${base}?cluster=${clusterParam}`;
}
