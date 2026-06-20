// Metro configuration for the Expo app in an npm-workspaces monorepo.
//
// As of Expo SDK 52, EXPO_USE_METRO_WORKSPACE_ROOT (on by default — and set in
// our npm scripts) makes `getDefaultConfig` auto-configure monorepo resolution:
// it watches the workspace root (so @golazo/core's TypeScript SOURCE still hot-
// reloads here) and resolves hoisted deps from the root node_modules. So we no
// longer hand-set watchFolders / nodeModulesPaths / disableHierarchicalLookup —
// those were SDK 51 workarounds. Keeping hierarchical lookup ON (the default)
// also lets nested deps resolve their own copies correctly (e.g. viem's own ox),
// which matters for the upcoming Privy integration.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Resolve modern package `exports` maps. Privy and the @solana/kit ecosystem
// publish subpath exports (e.g. `@solana/kit/program-client-core`,
// `x402/client`) that ONLY resolve through the exports field. On SDK 52 this is
// safe: hierarchical lookup is on, so viem resolves its own nested `ox` (no ESM
// `ox/erc8010` cascade like SDK 51 had with disableHierarchicalLookup).
config.resolver.unstable_enablePackageExports = true;

// Stub Privy's unused EVM / payment integrations → a no-op (metro-empty-stub.js).
// @privy-io/react-auth statically imports a wide surface of Ethereum-wallet and
// payment SDKs (x402, permissionless, Coinbase, WalletConnect, Abstract, Base,
// Stripe). Metro doesn't tree-shake, so it would force-resolve all of them even
// though GOLAZO only uses email/passkey login + a Solana embedded wallet. Routing
// them to a proxy stub keeps the EVM stack out of the bundle and those code paths
// never run for our Solana-only flows. (On SDK 52 the ox/viem resolution is fine
// thanks to hierarchical lookup, so only these top-level EVM modules need stubbing.)
const PRIVY_EVM_STUBS = [
  "x402",
  "permissionless",
  "@coinbase/wallet-sdk",
  // The whole WalletConnect / Reown (AppKit) stack — external-wallet connectors
  // we never use (GOLAZO uses Privy's *embedded* Solana wallet). Stubbing the
  // family also dodges a tslib `__extends` ESM-interop crash that @walletconnect/
  // time + heartbeat hit under Metro package-exports.
  "@walletconnect",
  "@reown",
  "@abstract-foundation/agw-client",
  "@base-org/account",
  "@stripe/crypto",
];
const emptyStub = path.resolve(__dirname, "metro-empty-stub.js");
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    PRIVY_EVM_STUBS.some(
      (m) => moduleName === m || moduleName.startsWith(m + "/"),
    )
  ) {
    return { type: "sourceFile", filePath: emptyStub };
  }
  return upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
