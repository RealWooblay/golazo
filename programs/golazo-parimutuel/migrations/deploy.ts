/**
 * Anchor deploy migration.
 *
 * `anchor test` / `anchor migrate` runs this after deploying the program. We
 * have nothing to bootstrap on-chain at deploy time — markets are created at
 * runtime via `initialize_market` — so this is intentionally a no-op stub kept
 * for the standard Anchor workspace layout.
 */

import * as anchor from "@coral-xyz/anchor";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);
  // No deploy-time setup required.
};
