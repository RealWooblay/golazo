// Metro configuration for an Expo app living inside an npm-workspaces monorepo.
//
// WHY this file exists:
//   This app consumes `@golazo/core` as raw TypeScript SOURCE (its package.json
//   `exports` map points at ./src/index.ts — there is no build step). Metro's
//   default config only watches the app folder and only resolves modules from
//   the app's own node_modules, so out of the box it can neither *find* the core
//   package nor *transpile* its .ts files. The two tweaks below fix exactly that
//   and follow the official Expo monorepo guide:
//   https://docs.expo.dev/guides/monorepos/
//
//   1. watchFolders = [repo root]  → Metro watches & bundles files outside the
//      app dir (i.e. ../../packages/core), and live-reloads when they change.
//   2. nodeModulesPaths            → resolve deps from the app first, then the
//      hoisted root node_modules (npm workspaces hoist most deps to the root).
//
// Metro already runs every source file (incl. node_modules) through Babel, and
// babel-preset-expo handles TypeScript, so no extra transformer wiring is needed
// to compile the core's .ts — it just needs to be inside a watch folder.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// apps/mobile -> apps -> repo root
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files in the monorepo so changes to @golazo/core hot-reload here.
config.watchFolders = [workspaceRoot];

// 2. Let Metro resolve packages from the app, then the hoisted root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Use the monorepo-friendly resolution: don't traverse upward looking for
// node_modules beyond the paths we listed (avoids picking up stray copies).
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
