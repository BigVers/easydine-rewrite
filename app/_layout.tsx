// app/_layout.tsx
// Root navigator layout.
// - Wraps everything in Auth + Theme providers.
// - Guards staff routes behind login.
// - Initialises OneSignal and registers the device.

import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Provider as PaperProvider } from 'react-native-paper';

import { AuthProvider, useAuth } from '../lib/AuthContext';
import { ThemeProvider } from '../lib/ThemeContext';
import { initOneSignal, getPlayerId, requestPermission } from '../lib/oneSignalManager';
import { registerDevice, saveOneSignalId } from '../lib/deviceService';

// ─── OneSignal bootstrap ─────────────────────────────────────────────────────

async function bootstrapOneSignal(branchId?: string) {
  initOneSignal();
  await requestPermission();

  const playerId = await getPlayerId();
  if (playerId) {
    await saveOneSignalId(playerId);
  }

  // Keep device record current
  await registerDevice({
    deviceType: 'receiver',  // Default; overridden during pairing
    deviceName: 'EasyDine Device',
    branchId,
    onesignalUserId: playerId ?? undefined,
  });
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

function RootLayoutContent() {
  const { session, profile, isLoading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  // Bootstrap OneSignal once (non-blocking)
  useEffect(() => {
    bootstrapOneSignal(profile?.branch_id ?? undefined).catch(
      (err) => console.warn('[layout] OneSignal bootstrap error:', err)
    );
  }, [profile?.branch_id]);

  // Auth routing guard
  useEffect(() => {
    if (isLoading) return;
    const onLoginPage = segments[0] === 'login';
    const isAuthenticated = Boolean(session && profile);

    if (!isAuthenticated && !onLoginPage) {
      router.replace('/login');
    } else if (isAuthenticated && onLoginPage) {
      router.replace('/');
    }
  }, [isLoading, session, profile, segments, router]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="index" />
      <Stack.Screen name="menu" />
      <Stack.Screen name="pairing" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="staff" />
    </Stack>
  );
}

// ─── Providers ───────────────────────────────────────────────────────────────

export default function RootLayout() {
  // branchId is resolved inside ThemeProvider from the env config
  const BRANCH_ID = process.env.EXPO_PUBLIC_BRANCH_ID ?? '';

  return (
    <AuthProvider>
      <ThemeProvider branchId={BRANCH_ID}>
        <PaperProvider>
          <RootLayoutContent />
        </PaperProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
