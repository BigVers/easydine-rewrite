// app/_layout.tsx
// Root layout — wraps the app in Auth, Theme and Paper providers.
// Branch/restaurant resolution is now handled inside ThemeProvider
// based on the logged-in user's profile — no EXPO_PUBLIC_BRANCH_ID needed.

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
    initOneSignal();
    await requestPermission();
  } catch (err) {
    console.warn('[layout] OneSignal bootstrap error:', err);
  }
}

export default function RootLayout() {
  useEffect(() => {
    bootstrapOneSignal();
  }, []);

  return (
    <AuthProvider>
      {/* branchId prop omitted — ThemeProvider resolves it from auth profile */}
      <AppThemeProvider>
        <PaperProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </PaperProvider>
      </AppThemeProvider>
    </AuthProvider>
  );
}
