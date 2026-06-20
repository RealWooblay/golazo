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
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import { chainConfig, type ChainConfig } from "./config";
import { IDL } from "./idl/golazo_parimutuel";
import { EmbeddedWallet } from "./wallet";

/** Confirmation level for reads + tx confirmation. `confirmed` is the sweet spot. */
const COMMITMENT: Commitment = "confirmed";

/**
 * Minimal anchor-compatible signer surface: a public key + the two tx signers
 * AnchorProvider calls. The embedded keypair adapter and the Privy adapter use
 * different internal generics, and AnchorProvider takes this via an `as Wallet`
 * cast anyway, so the tx params are intentionally loose here.
 */
export interface AnchorWalletLike {
  publicKey: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (tx: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAllTransactions: (txs: any[]) => Promise<any[]>;
}

/**
 * The wallet the chain context binds to. Satisfied by BOTH the legacy
 * {@link EmbeddedWallet} (native / Privy-off) and the Privy embedded-wallet
 * adapter (web). `client.ts` only ever reads `.publicKey`; signing goes through
 * `anchorWallet` via the AnchorProvider.
 */
export interface ChainSigner {
  publicKey: PublicKey;
  /** base58 pubkey — the deposit address shown in the UI. */
  address: string;
  anchorWallet: AnchorWalletLike;
}

/**
 * The lightweight handle the WEB Privy hook hands down to the chain layer. It
 * deliberately carries NO `@solana/web3.js` — only the wallet address and a
 * raw "sign these serialized bytes" function (wrapping Privy's wallet-standard
 * `signTransaction`). The heavy PublicKey / (de)serialize work happens HERE in
 * the lazily-loaded provider, so importing the hook never pulls web3 into the
 * eager bundle.
 */
export interface PrivyRawSigner {
  address: string;
  /** Sign a serialized tx; returns the serialized SIGNED tx. */
  signSerialized: (txBytes: Uint8Array) => Promise<Uint8Array>;
}

/** What the chain layer should bind to, decided by the Privy auth state. */
export type PrivySignerState =
  | { mode: "legacy" } // native / Privy-off → the local embedded keypair
  | { mode: "pending" } // Privy on, not signed in → real mode needs login
  | { mode: "privy"; signer: PrivyRawSigner };

/**
 * Wrap a {@link PrivyRawSigner} into an anchor-compatible {@link ChainSigner}.
 * AnchorProvider hands `signTransaction` a tx with feePayer + blockhash already
 * set; we serialize it, let Privy sign (no popup), and rebuild the signed tx.
 */
function buildPrivySigner(privy: PrivyRawSigner): ChainSigner {
  const publicKey = new PublicKey(privy.address);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sign = async (tx: any): Promise<any> => {
    const versioned = tx instanceof VersionedTransaction;
    const bytes = versioned
      ? tx.serialize()
      : (tx as Transaction).serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
    const signed = await privy.signSerialized(Uint8Array.from(bytes));
    if (versioned) return VersionedTransaction.deserialize(signed);
    const rebuilt = Transaction.from(Buffer.from(signed));
    // The signer is REMOTE (Privy) — assert it actually returned our signature,
    // so a missing/empty sig fails here with a clear message instead of as an
    // opaque "Signature verification failed" deep inside anchor's serialize().
    const mine = rebuilt.signatures.find((s) => s.publicKey.equals(publicKey));
    if (!mine?.signature) {
      throw new Error("Privy returned an unsigned transaction.");
    }
    return rebuilt;
  };
  return {
    publicKey,
    address: privy.address,
    anchorWallet: {
      publicKey,
      signTransaction: sign,
      signAllTransactions: (txs: unknown[]) =>
        Promise.all((txs as unknown[]).map((t) => sign(t))),
    },
  };
}

/**
 * The live, heavy chain handle. Held by `useChain()` for the duration of an
 * on-chain session and passed to every client helper. Constructed once via
 * {@link buildChainContext}.
 */
export interface ChainContext {
  config: ChainConfig;
  connection: Connection;
  wallet: ChainSigner;
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
export async function buildChainContext(
  privySigner?: PrivyRawSigner,
): Promise<BuildResult> {
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

    // The wallet: prefer the Privy embedded-wallet signer (web, signed-in) when
    // provided; otherwise fall back to the legacy locally-generated keypair
    // (native, or Privy not configured). The Privy path NEVER touches secure
    // storage — the key lives in Privy's MPC, not on this device.
    const wallet: ChainSigner = privySigner
      ? buildPrivySigner(privySigner)
      : await EmbeddedWallet.loadOrCreate();

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
