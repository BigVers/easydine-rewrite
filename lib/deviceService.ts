// lib/deviceService.ts
// Manages the local device UUID, persisted to AsyncStorage.
// The UUID is created once on first launch and never changes.

import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from './supabase';
import type { Device, DeviceType } from './types';

const DEVICE_ID_KEY = 'easydine:device_id';

let _cachedDeviceId: string | null = null;

/**
 * Returns (or creates) the persistent device UUID.
 * Result is cached in-memory for the lifetime of the app process.
 */
export async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId) return _cachedDeviceId;

  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = uuidv4();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  _cachedDeviceId = id;
  return id;
}

/**
 * Upserts the device record in Supabase and returns it.
 * Call this on app launch to keep `last_seen_at` and
 * `onesignal_user_id` fresh.
 */
export async function registerDevice(opts: {
  deviceType: DeviceType;
  deviceName: string;
  branchId?: string;
  onesignalUserId?: string;
}): Promise<Device> {
  const id = await getDeviceId();

  const payload = {
    id,
    device_type: opts.deviceType,
    device_name: opts.deviceName,
    branch_id: opts.branchId ?? null,
    onesignal_user_id: opts.onesignalUserId ?? null,
    last_seen_at: new Date().toISOString(),
    is_active: true,
  };

  const { data, error } = await supabase
    .from('devices')
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;
  return data as Device;
}

/**
 * Stores the OneSignal player ID on the device record.
 */
export async function saveOneSignalId(playerId: string): Promise<void> {
  const id = await getDeviceId();
  const { error } = await supabase
    .from('devices')
    .update({ onesignal_user_id: playerId, last_seen_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
