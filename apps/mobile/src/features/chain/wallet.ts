/**
 * EMBEDDED WALLET — a self-custodial Solana keypair the app generates and stores
 * for the user, so there's NO external wallet app to install (Rainbet-style,
 * normie-friendly). This is the single most important UX decision in the chain
 * layer: tap "go on-chain" and a wallet just exists.
 *
 * STORAGE (platform-aware, all behind a dynamic import so nothing loads on the
 * sandbox path):
 *   • Native (iOS/Android): the 64-byte secret key is stored in
 *     `expo-secure-store` (Keychain / Keystore) — encrypted at rest.
 *   • Web: SecureStore is unavailable, so we fall back to
 *     `@react-native-async-storage/async-storage` (localStorage under the hood).
 *     This is explicitly a DEV/SANDBOX convenience on web — never put real value
 *     on a web-stored key. The README documents this loudly.
 *
 * SECURITY POSTURE:
 *   • The secret key NEVER leaves this module. We expose the address, a balance,
 *     a devnet airdrop, and *signing functions* — not the raw key.
 *   • Keys live under a versioned storage key so a format bump can rotate them.
 *
 * This module DOES import the heavy libs (`@solana/web3.js`), so it must only be
 * reached through the dynamic `import()` in `provider.ts` / `useChain()`.
 */

import "./polyfills"; // crypto.getRandomValues + Buffer, before web3 touches them
import { Keypair, PublicKey } from "@solana/web3.js";

/** Versioned storage key so we can rotate the on-disk format later. */
const SECRET_STORAGE_KEY = "golazo.chain.wallet.secret.v1";
const ADDRESS_STORAGE_KEY = "golazo.chain.wallet.address.v1";

/** True on Expo Web, where SecureStore isn't available. */
function isWeb(): boolean {
  // react-native sets navigator.product to 'ReactNative' on native.
  return typeof document !== "undefined";
}

// ── Platform storage shim ────────────────────────────────────────────────────
// Both backends are dynamically imported so neither is bundled until on-chain
// mode is actually turned on.

async function storageGet(key: string): Promise<string | null> {
  if (isWeb()) {
    const AsyncStorage = (
      await import("@react-native-async-storage/async-storage")
    ).default;
    return AsyncStorage.getItem(key);
  }
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (isWeb()) {
    const AsyncStorage = (
      await import("@react-native-async-storage/async-storage")
    ).default;
    await AsyncStorage.setItem(key, value);
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(key, value);
}

async function storageDelete(key: string): Promise<void> {
  if (isWeb()) {
    const AsyncStorage = (
      await import("@react-native-async-storage/async-storage")
    ).default;
    await AsyncStorage.removeItem(key);
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.deleteItemAsync(key);
}

// ── Keypair persistence ──────────────────────────────────────────────────────

/** Serialize a Keypair's 64-byte secret to a JSON number array (like solana-keygen). */
function encodeSecret(kp: Keypair): string {
  return JSON.stringify(Array.from(kp.secretKey));
}

/** Parse a stored secret back into a Keypair; returns null if malformed. */
function decodeSecret(raw: string): Keypair | null {
  try {
    const arr = JSON.parse(raw) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) return null;
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return null;
  }
}

/**
 * Sign a transaction with `kp`, supporting BOTH legacy and versioned txs.
 * ORDER MATTERS: a legacy `Transaction` has BOTH `.partialSign(...signers)` AND
 * `.sign(...signers)` (variadic) — calling `.sign([kp])` on it passes an ARRAY as
 * the first signer, and web3 then reads `.publicKey` off the array → the
 * `undefined.toString()` crash. A `VersionedTransaction` has ONLY `.sign(signers[])`.
 * So we try the legacy `.partialSign(kp)` first, and only fall back to `.sign([kp])`.
 */
function signWith(
  tx: {
    sign?: (...s: Keypair[]) => void;
    partialSign?: (...s: Keypair[]) => void;
  },
  kp: Keypair,
): void {
  if (typeof tx.partialSign === "function") {
    tx.partialSign(kp);
  } else if (typeof tx.sign === "function") {
    (tx as unknown as { sign: (s: Keypair[]) => void }).sign([kp]);
  }
}

/**
 * The embedded wallet handle. Wraps a `Keypair` and exposes only safe surfaces.
 * Construct via {@link loadOrCreateWallet} — never instantiate directly.
 */
export class EmbeddedWallet {
  private constructor(private readonly keypair: Keypair) {}

  /** base58 public key — safe to display/share (it's a deposit address). */
  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** The `PublicKey` (consumed by the Anchor client internally). */
  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /**
   * An Anchor-compatible signer wallet ({ publicKey, signTransaction,
   * signAllTransactions }). Used to build the AnchorProvider. Supports both
   * legacy and versioned transactions.
   */
  get anchorWallet() {
    const kp = this.keypair;
    return {
      publicKey: kp.publicKey,
      async signTransaction<
        T extends {
          sign?: (...s: Keypair[]) => void;
          partialSign?: (...s: Keypair[]) => void;
        },
      >(tx: T): Promise<T> {
        signWith(tx, kp);
        return tx;
      },
      async signAllTransactions<T>(txs: T[]): Promise<T[]> {
        for (const tx of txs)
          signWith(tx as Parameters<typeof signWith>[0], kp);
        return txs;
      },
    };
  }

  /** The raw Keypair — for internal use only (e.g. funding airdrop signer). */
  get signer(): Keypair {
    return this.keypair;
  }

  /**
   * Load the persisted wallet, or generate + persist a fresh one on first run.
   * Idempotent: subsequent calls return the same stored key.
   */
  static async loadOrCreate(): Promise<EmbeddedWallet> {
    const existing = await storageGet(SECRET_STORAGE_KEY);
    if (existing) {
      const kp = decodeSecret(existing);
      if (kp) {
        await storageSet(ADDRESS_STORAGE_KEY, kp.publicKey.toBase58());
        return new EmbeddedWallet(kp);
      }
      // Corrupt entry — never silently mint a new key (that would orphan funds).
      throw new Error(
        "Saved wallet is corrupted. Clear site data or contact support.",
      );
    }
    const kp = Keypair.generate();
    await storageSet(SECRET_STORAGE_KEY, encodeSecret(kp));
    await storageSet(ADDRESS_STORAGE_KEY, kp.publicKey.toBase58());
    return new EmbeddedWallet(kp);
  }

  /** Read the persisted address without loading web3 signing state. */
  static async peekAddress(): Promise<string | null> {
    return storageGet(ADDRESS_STORAGE_KEY);
  }

  /**
   * DESTROY the stored key. Use for "log out / reset wallet". Irreversible —
   * funds at the old address become unrecoverable (this is play money on devnet).
   */
  static async destroy(): Promise<void> {
    await storageDelete(SECRET_STORAGE_KEY);
    await storageDelete(ADDRESS_STORAGE_KEY);
  }
}
