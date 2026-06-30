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
const fs = require("fs");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Resolve modern package `exports` maps. Privy and the @solana/kit ecosystem
// publish subpath exports (e.g. `@solana/kit/program-client-core`,
// `x402/client`) that ONLY resolve through the exports field. On SDK 52 this is
// safe: hierarchical lookup is on, so viem resolves its own nested `ox` (no ESM
// `ox/erc8010` cascade like SDK 51 had with disableHierarchicalLookup).
config.resolver.unstable_enablePackageExports = true;

// Stub Privy's unused EVM integrations → a no-op (metro-empty-stub.js).
// @privy-io/react-auth statically imports a wide surface of Ethereum-wallet SDKs
// (x402, permissionless, Coinbase, WalletConnect, Abstract, Base). Metro doesn't
// tree-shake, so it would force-resolve all of them even though GOLAZO only uses
// email/wallet login + a Solana embedded wallet.
//
// Solana external wallets (Phantom) need @walletconnect/universal-provider +
// toSolanaWalletConnectors — do NOT stub the whole @walletconnect family. Stub
// only the ETHEREUM provider + Reown AppKit (tslib/__extends + import.meta via
// valtio). Force tslib + valtio to their CJS builds below.
//
// @stripe/crypto is NOT stubbed — Privy's useFiatOnramp Stripe onramp requires it
// (peer dependency of @privy-io/react-auth).
const PRIVY_EVM_STUBS = [
  "x402",
  "permissionless",
  "@coinbase/wallet-sdk",
  "@walletconnect/ethereum-provider",
  "@reown",
  "@abstract-foundation/agw-client",
  "@base-org/account",
];
const emptyStub = path.resolve(__dirname, "metro-empty-stub.js");
const valtioRoot = path.resolve(__dirname, "../../node_modules/valtio");

/** Metro package-exports picks valtio's ESM build (import.meta) — force CJS for web. */
function resolveValtioCjs(moduleName) {
  if (moduleName === "valtio") {
    return path.join(valtioRoot, "index.js");
  }
  if (moduleName.startsWith("valtio/")) {
    const sub = moduleName.slice("valtio/".length);
    const candidate = path.join(valtioRoot, `${sub}.js`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** tslib ESM lacks default.__extends — WalletConnect CJS expects tslib.js. */
function resolveTslibCjs(context, moduleName) {
  if (moduleName !== "tslib" && !moduleName.startsWith("tslib/")) return null;
  const originDir = context.originModulePath
    ? path.dirname(context.originModulePath)
    : path.resolve(__dirname, "../..");
  const candidates = [
    path.join(originDir, "node_modules/tslib/tslib.js"),
    path.resolve(__dirname, "../../node_modules/tslib/tslib.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const tslibPath = resolveTslibCjs(context, moduleName);
  if (tslibPath) {
    return { type: "sourceFile", filePath: tslibPath };
  }
  const valtioPath = resolveValtioCjs(moduleName);
  if (valtioPath) {
    return { type: "sourceFile", filePath: valtioPath };
  }
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
