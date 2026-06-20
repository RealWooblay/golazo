// Babel config for the Expo app.
//
// - `babel-preset-expo` is the single preset every Expo app uses; it bundles the
//   TypeScript + JSX + React Native transforms. Because Metro pipes *all* source
//   (including ../../packages/core/src/*.ts) through Babel, this preset is what
//   actually compiles the @golazo/core TypeScript we import.
// - `react-native-reanimated/plugin` MUST be listed LAST. Reanimated rewrites
//   worklets at build time and the plugin breaks if any other plugin runs after
//   it. We use Reanimated for the countdown ring + reveal flip animations.
// expo-router v4 (SDK 52) inlines `process.env.EXPO_ROUTER_APP_ROOT` into the
// `require.context(...)` inside expo-router/_ctx — but in this monorepo the CLI's
// auto-detection of the app dir doesn't always set it before the Babel worker
// runs, which crashes the transform ("first argument of require.context should be
// a string"). Pin it to this package's `app/` directory so the worker always has
// it, no matter how the dev server was launched.
const path = require('path');
process.env.EXPO_ROUTER_APP_ROOT =
  process.env.EXPO_ROUTER_APP_ROOT || path.resolve(__dirname, 'app');

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
