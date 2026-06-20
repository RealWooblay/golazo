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
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

module.exports = config;
