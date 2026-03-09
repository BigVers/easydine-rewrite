// lib/oneSignalManager.ts

import { OneSignal } from 'react-native-onesignal';
import { Platform, PermissionsAndroid } from 'react-native';
import { saveOneSignalId } from './deviceService';

const APP_ID = process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID ?? '';

let _initialised = false;

// JS-side cache — set the moment the change event fires.
// Polling reads from here, not from the native layer which can return {}
// after the initial change event has already been consumed.
let _cachedSubscriptionId: string | null = null;

export function initOneSignal(): void {
  if (_initialised || !APP_ID) return;
  _initialised = true;

  OneSignal.initialize(APP_ID);

  OneSignal.User.pushSubscription.addEventListener('change', (event) => {
    const id = event?.current?.id;
    if (id) {
      console.log('[OneSignal] ✅ Subscription ID ready:', id);
      _cachedSubscriptionId = id; // cache immediately
      saveOneSignalId(id).catch((err) =>
        console.warn('[OneSignal] ❌ Failed to save subscription ID to DB:', err)
      );
    }
  });

  // Also check immediately — on restart the change event won't re-fire
  // Try multiple property paths since SDK v5 is inconsistent across builds
  const sub = OneSignal.User?.pushSubscription as any;
  const existingId = sub?.id ?? sub?.token ?? sub?.subscriptionId ?? null;
  if (existingId) {
    console.log('[OneSignal] ✅ Subscription ID already available on init:', existingId);
    _cachedSubscriptionId = existingId;
    saveOneSignalId(existingId).catch(() => {});
  } else {
    console.log('[OneSignal] Subscription ID not yet available — waiting for change event...');
  }
}

/**
 * Polls the JS-side cache (set by change event) every 500ms.
 * Falls back to reading the native object directly as a last resort.
 * Always resolves — returns null on timeout.
 */
export async function waitForPlayerId(timeoutMs = 10000): Promise<string | null> {
  // Check cache immediately first
  if (_cachedSubscriptionId) {
    console.log('[OneSignal] waitForPlayerId: cache hit:', _cachedSubscriptionId);
    return _cachedSubscriptionId;
  }

  // Also try native read immediately
  const sub = OneSignal.User?.pushSubscription as any;
  const immediate = sub?.id ?? sub?.token ?? null;
  if (immediate) {
    console.log('[OneSignal] waitForPlayerId: native read hit:', immediate);
    _cachedSubscriptionId = immediate;
    return immediate;
  }

  console.log('[OneSignal] waitForPlayerId: waiting (cache empty, native empty)...');

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      // Check cache first (set by change event listener)
      if (_cachedSubscriptionId) {
        console.log('[OneSignal] waitForPlayerId: ✅ cache populated:', _cachedSubscriptionId);
        clearInterval(interval);
        clearTimeout(timer);
        resolve(_cachedSubscriptionId);
        return;
      }
      // Fallback: try native read
      const s = OneSignal.User?.pushSubscription as any;
      const id = s?.id ?? s?.token ?? null;
      if (id) {
        console.log('[OneSignal] waitForPlayerId: ✅ native read:', id);
        _cachedSubscriptionId = id;
        clearInterval(interval);
        clearTimeout(timer);
        resolve(id);
      }
    }, 500);

    const timer = setTimeout(() => {
      clearInterval(interval);
      console.warn('[OneSignal] waitForPlayerId timed out. Cache:', _cachedSubscriptionId, 'Native:', (OneSignal.User?.pushSubscription as any)?.id);
      // Return cache even if we timed out — change event may have fired
      resolve(_cachedSubscriptionId);
    }, timeoutMs);
  });
}

export async function requestPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      console.warn('[OneSignal] POST_NOTIFICATIONS permission denied');
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    if (typeof OneSignal.Notifications?.requestPermission === 'function') {
      OneSignal.Notifications.requestPermission(true).then((granted) => {
        console.log('[OneSignal] Notification permission:', granted ? 'granted' : 'denied');
        resolve(granted);
      });
    } else {
      (OneSignal as any).promptForPushNotificationsWithUserResponse(resolve);
    }
  });
}

export async function getPlayerId(): Promise<string | null> {
  return _cachedSubscriptionId ?? (OneSignal.User?.pushSubscription as any)?.id ?? null;
}
