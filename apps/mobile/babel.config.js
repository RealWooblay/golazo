// Babel config for the Expo app.
//
// - `babel-preset-expo` is the single preset every Expo app uses; it bundles the
//   TypeScript + JSX + React Native transforms. Because Metro pipes *all* source
//   (including ../../packages/core/src/*.ts) through Babel, this preset is what
//   actually compiles the @golazo/core TypeScript we import.
// - `react-native-reanimated/plugin` MUST be listed LAST. Reanimated rewrites
//   worklets at build time and the plugin breaks if any other plugin runs after
//   it. We use Reanimated for the countdown ring + reveal flip animations.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
