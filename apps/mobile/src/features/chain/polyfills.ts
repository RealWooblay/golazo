/**
 * RUNTIME POLYFILLS for the Solana stack — imported **only** from inside the
 * lazily-loaded chain modules, NEVER at the top of a screen.
 *
 * Why these are needed:
 *   • `react-native-get-random-values` shims `crypto.getRandomValues`, which
 *     `@solana/web3.js` (and tweetnacl, used for keypair signing) require to
 *     generate secure randomness. React Native has no Web Crypto by default.
 *   • `Buffer` is assumed-global by web3.js / @coral-xyz/anchor for serializing
 *     instruction data and PDAs. RN has no global Buffer, so we attach one.
 *
 * Why it's safe for web:
 *   On Expo Web the browser already provides `crypto.getRandomValues`, and
 *   `buffer` resolves to the npm shim, so importing this is a no-op-ish and does
 *   not break the web bundle. Crucially this file is reached ONLY through the
 *   dynamic `import()` in `provider.ts`, so a screen that never turns on
 *   on-chain mode never pulls Buffer or the crypto shim into its bundle.
 *
 * Idempotent: importing more than once is harmless.
 */

// MUST be first: installs crypto.getRandomValues before anything reads it.
import "react-native-get-random-values";
import { Buffer } from "buffer";

declare const global: typeof globalThis & { Buffer?: typeof Buffer };

if (typeof global !== "undefined" && typeof global.Buffer === "undefined") {
  global.Buffer = Buffer;
}

export {};
