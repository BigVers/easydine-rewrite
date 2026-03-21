// metro.config.js
//
// Redirects react-native-get-random-values to a pure-JS mock so the
// bundler never tries to resolve the native module (RNGetRandomValues).
// This is required because @supabase/supabase-js pulls it in transitively
// and Metro resolves modules independently of npm overrides.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'react-native-get-random-values': require.resolve('./mocks/react-native-get-random-values'),
};

module.exports = config;
