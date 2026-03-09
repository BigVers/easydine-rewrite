// app/_layout.tsx

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { Provider as PaperProvider } from 'react-native-paper';

import { ThemeProvider as AppThemeProvider } from '../lib/ThemeContext';
import { AuthProvider } from '../lib/AuthContext';
import { initOneSignal, requestPermission } from '../lib/oneSignalManager';

async function bootstrapOneSignal() {
  try {
    // initOneSignal registers the pushSubscription.change listener.
    // That listener calls saveOneSignalId() the moment OneSignal assigns
    // a subscription ID — regardless of which screen the user is on.
    // This guarantees onesignal_user_id is always written to the DB on
    // every launch, so the Edge Function can always find it.
    initOneSignal();
    await requestPermission();
  } catch (err) {
    console.warn('[layout] OneSignal bootstrap error:', err);
  }
}

export default function RootLayout() {
  const BRANCH_ID = process.env.EXPO_PUBLIC_BRANCH_ID ?? '';

  useEffect(() => {
    bootstrapOneSignal();
  }, []);

  return (
    <AuthProvider>
      <AppThemeProvider branchId={BRANCH_ID}>
        <PaperProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </PaperProvider>
      </AppThemeProvider>
    </AuthProvider>
  );
}
