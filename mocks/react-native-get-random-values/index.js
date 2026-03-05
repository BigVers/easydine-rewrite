// mocks/react-native-get-random-values/index.js
//
// Pure-JS polyfill. Patches global.crypto.getRandomValues so uuid and
// @supabase/supabase-js work without any native module.

if (typeof global.crypto === 'undefined') {
  global.crypto = {};
}
if (typeof global.crypto.getRandomValues === 'undefined') {
  global.crypto.getRandomValues = function (buffer) {
    for (var i = 0; i < buffer.length; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
    return buffer;
  };
}
