// app/_layout.tsx
// Root layout — wraps the app in Auth, Theme and Paper providers.
//
// Fix: bootstrapDevice() now runs on every launch to ensure:
//   1. The device row exists in Supabase before the OneSignal change
//      event fires (prevents saveOneSignalId() from silently no-oping
//      against a non-existent row when using plain UPDATE).
//   2. If the OneSignal subscription ID is already cached from a
//      previous session, it is saved immediately without waiting for
//      the change event to re-fire (it won't on restart).

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { Provider as PaperProvider } from 'react-native-paper';

import { ThemeProvider as AppThemeProvider } from '../lib/ThemeContext';
import { AuthProvider } from '../lib/AuthContext';
import { initOneSignal, requestPermission, getPlayerId } from '../lib/oneSignalManager';
import { registerDevice, saveOneSignalId } from '../lib/deviceService';

async function bootstrapDevice() {
  try {
    // 1. Initialise OneSignal — registers the change event listener that
    //    calls saveOneSignalId() the moment a subscription ID is assigned.
    initOneSignal();

    // 2. Ensure the device row exists in Supabase with safe defaults.
    //    This must happen before saveOneSignalId() is called so the upsert
    //    has a row to update (or creates one if missing).
    //    Device type defaults to 'receiver' — overwritten during pairing.
    await registerDevice({ deviceType: 'receiver', deviceName: 'Waiter Device' });

    // 3. Request push notification permission.
    await requestPermission();

    // 4. If the subscription ID is already available (app restart, not
    //    first launch), save it now — the change event won't re-fire.
    const existingId = await getPlayerId();
    if (existingId) {
      console.log('[layout] ✅ Subscription ID available on launch, saving:', existingId);
      await saveOneSignalId(existingId);
    }
  } catch (err) {
    console.warn('[layout] Bootstrap error:', err);
  }
}

export default function RootLayout() {
  useEffect(() => {
    bootstrapDevice();
  }, []);

  return (
    <AuthProvider>
      <AppThemeProvider>
        <PaperProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </PaperProvider>
      </AppThemeProvider>
    </AuthProvider>
  );
}
