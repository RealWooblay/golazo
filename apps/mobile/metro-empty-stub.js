// Catch-all STUB for Privy's optional EVM / payment dependencies.
//
// @privy-io/react-auth is built for tree-shaking bundlers (webpack/vite), so it
// statically imports a wide surface of optional integrations — Ethereum wallets
// (permissionless, @coinbase/wallet-sdk, @walletconnect/ethereum-provider,
// @abstract-foundation/agw-client) and payment rails (x402, @stripe/crypto).
// Metro does NOT tree-shake, so it must resolve every one of those imports even
// though GOLAZO only uses email/passkey login + a Solana embedded wallet.
//
// Rather than install (and ship) the entire EVM ecosystem, we resolve those
// modules to this no-op proxy. It answers any property access with a callable
// proxy, so `import { foo } from 'x402/client'` and `foo()` both no-op instead
// of crashing — safe because none of those code paths ever execute for our
// Solana-only flows. See metro.config.js `resolveRequest`.
const noop = function () {};
const handler = {
  get(_target, prop) {
    if (prop === "__esModule") return true;
    return proxy;
  },
  apply() {
    return proxy;
  },
};
const proxy = new Proxy(noop, handler);

module.exports = proxy;
