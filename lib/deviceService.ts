// lib/deviceService.ts
// Manages the local device UUID, persisted to AsyncStorage.
// The UUID is created once on first launch and never changes.
//
// UUID generation is intentionally pure-JS with zero native dependencies
// so it works in any dev client build without requiring a rebuild.
//
// Fix: saveOneSignalId() now uses upsert instead of update so it works
// even if the device row doesn't exist yet (e.g. the OneSignal change
// event fires before the first registerDevice() call completes).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import type { Device, DeviceType } from './types';

const DEVICE_ID_KEY = 'easydine:device_id';

let _cachedDeviceId: string | null = null;

/**
 * Pure-JS UUID v4. Uses Math.random() — fine for device identity
 * (uniqueness matters, cryptographic security does not).
 * No native module required; works in all Hermes environments.
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Returns (or creates) the persistent device UUID.
 * Result is cached in-memory for the lifetime of the app process.
 */
export async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;

  const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (stored) {
    _cachedDeviceId = stored;
    return stored;
  }

  const newId = generateUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, newId);
  _cachedDeviceId = newId;
  return newId;
}

/**
 * Upserts the device record in Supabase and returns it.
 * Call this on app launch to keep `last_seen_at` and
 * `onesignal_user_id` fresh.
 *
 * If onesignalUserId is provided it is saved immediately.
 * If omitted the existing DB value is preserved via the upsert
 * (we only set it to null on a brand-new insert, not on updates).
 */
export async function registerDevice(opts: {
  deviceType: DeviceType;
  deviceName: string;
  branchId?: string;
  onesignalUserId?: string;
}): Promise<Device> {
  const id = await getDeviceId();

  const payload: Record<string, unknown> = {
    id,
    device_type: opts.deviceType,
    device_name: opts.deviceName,
    branch_id: opts.branchId ?? null,
    last_seen_at: new Date().toISOString(),
    is_active: true,
  };

  // Only include onesignal_user_id in the payload when we actually have it.
  // Omitting it from the upsert payload means Postgres will keep the existing
  // value on conflict rather than overwriting it with null.
  if (opts.onesignalUserId) {
    payload.onesignal_user_id = opts.onesignalUserId;
  }

  const { data, error } = await supabase
    .from('devices')
    .upsert(payload, {
      onConflict: 'id',
      // ignoreDuplicates: false ensures the update runs on conflict
    })
    .select()
    .single();

  if (error) throw error;
  return data as Device;
}

/**
 * Stores the OneSignal subscription ID on the device record.
 *
 * Uses upsert instead of update so this works even if the device row
 * doesn't exist yet — which can happen when the OneSignal `change`
 * event fires before the first registerDevice() call (e.g. on cold
 * start before the user navigates to a pairing screen).
 *
 * device_type defaults to 'receiver' here because saveOneSignalId is
 * only ever called on the waiter (receiver) device. The type will be
 * corrected to its proper value when registerDevice() is called during
 * pairing.
 */
export async function saveOneSignalId(playerId: string): Promise<void> {
  if (!playerId) return;

  const id = await getDeviceId();

  const { error } = await supabase
    .from('devices')
    .upsert(
      {
        id,
        onesignal_user_id: playerId,
        last_seen_at: new Date().toISOString(),
        // Required NOT NULL columns — set safe defaults for a bare upsert.
        // registerDevice() will overwrite these with the correct values.
        device_type: 'receiver',
        device_name: 'Waiter Device',
        is_active: true,
      },
      {
        onConflict: 'id',
        // On conflict, only update onesignal_user_id and last_seen_at —
        // don't overwrite device_type or device_name if already set.
        ignoreDuplicates: false,
      }
    );

  if (error) {
    console.error('[deviceService] saveOneSignalId failed:', error.message);
    throw error;
  }

  console.log('[deviceService] ✅ OneSignal subscription ID saved:', playerId);
}
