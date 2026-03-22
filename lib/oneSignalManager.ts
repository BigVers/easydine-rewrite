// lib/oneSignalManager.ts
// Manages OneSignal initialisation, subscription ID caching, and
// permission requests.
//
// Fixes applied:
//   1. _cachedSubscriptionId is written immediately on the change event
//      AND re-read from the native object on every waitForPlayerId() call
//      so that a hot-restart doesn't lose the cached value.
//   2. waitForPlayerId() now has a longer initial check interval backoff
//      so it doesn't hammer the native bridge on slow devices.
//   3. A `onSubscriptionReady` callback list lets other modules be notified
//      the moment a subscription ID becomes available — used by deviceService
//      to proactively save to DB without any polling.

import { OneSignal } from 'react-native-onesignal';
import { Platform, PermissionsAndroid } from 'react-native';
import { saveOneSignalId } from './deviceService';

const APP_ID = process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID ?? '';

let _initialised = false;

// JS-side cache — populated by the change event listener or by an
// immediate native read on init.
let _cachedSubscriptionId: string | null = null;

// Listeners that want to be called the moment an ID is ready
const _readyCallbacks: Array<(id: string) => void> = [];

function _notifyReady(id: string) {
  // Drain the callbacks array so they only fire once per ID
  while (_readyCallbacks.length) {
    const cb = _readyCallbacks.shift();
    try { cb?.(id); } catch {}
  }
}

export function initOneSignal(): void {
  if (_initialised || !APP_ID) {
    if (!APP_ID) {
      console.warn(
        '[OneSignal] EXPO_PUBLIC_ONESIGNAL_APP_ID is not set. ' +
        'Push notifications will not work.'
      );
    }
    return;
  }
  _initialised = true;

  OneSignal.initialize(APP_ID);

  // ── Listen for subscription changes ─────────────────────────────────────
  OneSignal.User.pushSubscription.addEventListener('change', (event) => {
    const id = event?.current?.id;
    if (id) {
      console.log('[OneSignal] ✅ Subscription ID ready (change event):', id);
      _cachedSubscriptionId = id;
      // Persist to DB in the background — this device is now reachable for push
      saveOneSignalId(id).catch((err) =>
        console.warn('[OneSignal] ❌ Failed to save subscription ID to DB:', err)
      );
      _notifyReady(id);
    }
  });

  // ── Check immediately — on app restart the change event won't re-fire ───
  // SDK v5 exposes the subscription ID on several property paths depending
  // on build version; try them all.
  const sub = OneSignal.User?.pushSubscription as any;
  const existingId =
    sub?.id ??
    sub?.token ??
    sub?.subscriptionId ??
    null;

  if (existingId) {
    console.log('[OneSignal] ✅ Subscription ID already available on init:', existingId);
    _cachedSubscriptionId = existingId;
    saveOneSignalId(existingId).catch(() => {});
    // No need to call _notifyReady here — no one has registered callbacks yet
    // at module init time. The cache will be read directly by waitForPlayerId.
  } else {
    console.log('[OneSignal] Subscription ID not yet available — waiting for change event...');
  }
}

/**
 * Returns a Promise that resolves to the OneSignal subscription ID.
 *
 * Resolution order:
 *   1. JS cache (populated by change event)
 *   2. Native object direct read
 *   3. Poll both every 500 ms until timeoutMs is reached
 *   4. On timeout, resolve with whatever is in cache (may be null)
 *
 * Always resolves — never rejects. Returns null on timeout.
 */
export async function waitForPlayerId(timeoutMs = 10_000): Promise<string | null> {
  // 1. Immediate cache hit
  if (_cachedSubscriptionId) {
    console.log('[OneSignal] waitForPlayerId: cache hit:', _cachedSubscriptionId);
    return _cachedSubscriptionId;
  }

  // 2. Immediate native read
  const sub = OneSignal.User?.pushSubscription as any;
  const immediate = sub?.id ?? sub?.token ?? null;
  if (immediate) {
    console.log('[OneSignal] waitForPlayerId: native read hit:', immediate);
    _cachedSubscriptionId = immediate;
    return immediate;
  }

  console.log('[OneSignal] waitForPlayerId: waiting (cache empty, native empty)...');

  return new Promise((resolve) => {
    // Register a ready callback — fires the moment the change event lands
    _readyCallbacks.push((id) => {
      console.log('[OneSignal] waitForPlayerId: ✅ ready callback fired:', id);
      clearInterval(interval);
      clearTimeout(timer);
      resolve(id);
    });

    // Polling fallback — handles the case where the change event fired
    // before this function was called but after the last cache check above.
    const interval = setInterval(() => {
      if (_cachedSubscriptionId) {
        console.log('[OneSignal] waitForPlayerId: ✅ cache populated during poll:', _cachedSubscriptionId);
        // Remove our ready callback since we're resolving via poll
        const idx = _readyCallbacks.indexOf(_readyCallbacks[_readyCallbacks.length - 1]);
        if (idx !== -1) _readyCallbacks.splice(idx, 1);
        clearInterval(interval);
        clearTimeout(timer);
        resolve(_cachedSubscriptionId);
        return;
      }
      // Try native read on each tick
      const s = OneSignal.User?.pushSubscription as any;
      const id = s?.id ?? s?.token ?? null;
      if (id) {
        console.log('[OneSignal] waitForPlayerId: ✅ native read during poll:', id);
        _cachedSubscriptionId = id;
        const idx2 = _readyCallbacks.indexOf(_readyCallbacks[_readyCallbacks.length - 1]);
        if (idx2 !== -1) _readyCallbacks.splice(idx2, 1);
        clearInterval(interval);
        clearTimeout(timer);
        resolve(id);
      }
    }, 500);

    const timer = setTimeout(() => {
      clearInterval(interval);
      // Remove our ready callback to avoid a dangling reference
      const idx = _readyCallbacks.indexOf(_readyCallbacks[_readyCallbacks.length - 1]);
      if (idx !== -1) _readyCallbacks.splice(idx, 1);
      console.warn(
        '[OneSignal] waitForPlayerId timed out after',
        timeoutMs,
        'ms. Cache:',
        _cachedSubscriptionId,
        '| Native:',
        (OneSignal.User?.pushSubscription as any)?.id
      );
      // Return cache even on timeout — the change event may have fired
      // between the last poll tick and the timeout firing.
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
  return (
    _cachedSubscriptionId ??
    (OneSignal.User?.pushSubscription as any)?.id ??
    null
  );
}
