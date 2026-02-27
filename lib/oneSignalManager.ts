// lib/oneSignalManager.ts
// Thin wrapper around react-native-onesignal.
// Responsible for: initialisation, permission requests, player-ID retrieval.
// Does NOT contain business logic — call saveOneSignalId() from deviceService
// after obtaining the player ID.

import { OneSignal } from 'react-native-onesignal';
import { Platform, PermissionsAndroid } from 'react-native';

const APP_ID = process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID ?? '';

let _initialised = false;

/**
 * Initialises OneSignal. Safe to call multiple times (idempotent).
 */
export function initOneSignal(): void {
  if (_initialised || !APP_ID) return;
  OneSignal.initialize(APP_ID);
  _initialised = true;
}

/**
 * Requests push notification permission from the OS.
 * Returns true if permission was granted.
 */
export async function requestPermission(): Promise<boolean> {
  // Android 13+ requires a runtime permission prompt
  if (Platform.OS === 'android') {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
  }

  return new Promise<boolean>((resolve) => {
    if (typeof OneSignal.Notifications?.requestPermission === 'function') {
      OneSignal.Notifications.requestPermission(true).then(resolve);
    } else {
      // Legacy API fallback
      (OneSignal as any).promptForPushNotificationsWithUserResponse(resolve);
    }
  });
}

/**
 * Returns the OneSignal player / subscription ID, or null if not yet assigned.
 */
export async function getPlayerId(): Promise<string | null> {
  // SDK v5+
  const id = (OneSignal as any).User?.pushSubscription?.id;
  if (id) return id;

  // SDK v4 (getDeviceState)
  if (typeof (OneSignal as any).getDeviceState === 'function') {
    const state = await (OneSignal as any).getDeviceState();
    return state?.userId ?? null;
  }

  return null;
}
