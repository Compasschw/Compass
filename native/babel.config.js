// Babel config for the Expo mobile app.
//
// react-native-worklets/plugin (added for Reanimated v4+) MUST be listed
// LAST in the plugins array — it relies on other plugins running first so
// it can correctly identify and compile worklet functions.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      'react-native-worklets/plugin',
    ],
  };
};
