// app/_layout.tsx
// Root navigator layout.
// - Wraps everything in Auth + AppTheme providers.
// - Initialises OneSignal on mount.
//
// Auth redirects are handled declaratively inside each screen using
// Expo Router's <Redirect /> component. This is the correct pattern for
// Expo Router 4 and avoids the "right operand of 'in' is not an object"
// crash that occurs when router.replace() is called imperatively before
// the native stack navigator's SceneView has finished mounting.

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { Provider as PaperProvider } from 'react-native-paper';

// Aliased to avoid a naming clash with react-native-paper's own ThemeProvider.
import { ThemeProvider as AppThemeProvider } from '../lib/ThemeContext';
import { AuthProvider } from '../lib/AuthContext';
import { initOneSignal, getPlayerId, requestPermission } from '../lib/oneSignalManager';
import { registerDevice, saveOneSignalId } from '../lib/deviceService';

// ─── OneSignal bootstrap ──────────────────────────────────────────────────────

async function bootstrapOneSignal() {
  try {
    initOneSignal();
    await requestPermission();
    const playerId = await getPlayerId();
    if (playerId) await saveOneSignalId(playerId);
    await registerDevice({
      deviceType: 'receiver',
      deviceName: 'EasyDine Device',
      onesignalUserId: playerId ?? undefined,
    });
  } catch (err) {
    console.warn('[layout] OneSignal bootstrap error:', err);
  }
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const BRANCH_ID = process.env.EXPO_PUBLIC_BRANCH_ID ?? '';

  useEffect(() => {
    bootstrapOneSignal();
  }, []);

  return (
    <AuthProvider>
      <AppThemeProvider branchId={BRANCH_ID}>
        <PaperProvider>
          {/*
           * Self-closing <Stack /> with only global screenOptions.
           * Expo Router auto-discovers every file under app/ — do not list
           * Stack.Screen entries for folder routes unless you need per-screen
           * options. If you do list them, use the segment name only
           * (e.g. "menu") — never the file path (e.g. "menu/index").
           */}
          <Stack screenOptions={{ headerShown: false }} />
        </PaperProvider>
      </AppThemeProvider>
    </AuthProvider>
  );
}
