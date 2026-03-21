// lib/notificationService.ts
// Handles all push notification delivery via OneSignal REST API (server-side)
// and Supabase real-time subscription (waiter dashboard).
//
// The REST call goes through a Supabase Edge Function so that the
// OneSignal REST API key is NEVER exposed to the client app.

import { supabase } from './supabase';
import { getDeviceId } from './deviceService';
import type { Notification, NotificationType, WaiterGridRow } from './types';

// ── Sending (from patron tablet / requestor) ─────────────────────────────────

export interface SendNotificationPayload {
  pairingId: string;
  notificationType: NotificationType;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Inserts a notification row + triggers OneSignal push via Edge Function.
 */
export async function sendNotification(
  payload: SendNotificationPayload
): Promise<Notification> {
  const { data: notification, error: insertError } = await supabase
    .from('notifications')
    .insert({
      pairing_id: payload.pairingId,
      notification_type: payload.notificationType,
      message: payload.message,
      metadata: payload.metadata ?? null,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  // Awaited so Metro logs show the Edge Function result — helps diagnose push issues.
  try {
    const { data: fnData, error: fnError } = await supabase.functions.invoke('send-notification', {
      body: { notificationId: notification.id, pairingId: payload.pairingId },
    });
    if (fnError) {
      let detail = fnError.message;
      try {
        const ctx = (fnError as any).context;
        if (ctx) {
          const text = await ctx.text?.();
          detail = text || detail;
        }
      } catch {}
      console.warn('[notificationService] ❌ Edge Function error body:', detail);
    } else {
      console.log('[notificationService] ✅ Edge Function response:', JSON.stringify(fnData));
    }
  } catch (err) {
    console.warn('[notificationService] ❌ Edge Function threw:', err);
  }

  return notification as Notification;
}

// ── Reading (on waiter device / receiver) ────────────────────────────────────

/**
 * Fetches all active pairings for the current waiter device together with
 * the latest notification for each, using the `latest_notification_per_pairing`
 * Postgres view (DISTINCT ON pairing_id ORDER BY created_at DESC).
 *
 * This replaces the previous pattern of fetching all historical notifications
 * and grouping them in JavaScript, avoiding unnecessary data transfer.
 */
export async function getWaiterGridRows(): Promise<WaiterGridRow[]> {
  const receiverId = await getDeviceId();

  // Single query: join active pairings with the latest-notification view.
  // Supabase PostgREST supports joining views as if they were tables.
  const { data, error } = await supabase
    .from('pairings')
    .select(
      `id,
       table_name,
       latest_notification_per_pairing (
         notification_id,
         notification_type,
         message,
         is_actioned
       )`
    )
    .eq('receiver_id', receiverId)
    .eq('is_active', true);

  if (error) throw error;
  if (!data?.length) return [];

  return data.map((p): WaiterGridRow => {
    // PostgREST returns the joined view row as an object (or null if no notifications yet)
    const latest = Array.isArray(p.latest_notification_per_pairing)
      ? p.latest_notification_per_pairing[0] ?? null
      : (p.latest_notification_per_pairing as any) ?? null;

    return {
      pairingId: p.id,
      tableName: p.table_name,
      latestNotificationId: latest?.notification_id ?? null,
      notificationType: (latest?.notification_type as NotificationType) ?? null,
      requestMade: latest?.message ?? '—',
      isActioned: latest?.is_actioned ?? true,
    };
  });
}

/**
 * Marks a single notification as actioned by the current receiver.
 */
export async function markActioned(notificationId: string): Promise<void> {
  const receiverId = await getDeviceId();
  const { error } = await supabase
    .from('notifications')
    .update({
      is_actioned: true,
      actioned_at: new Date().toISOString(),
      actioned_by: receiverId,
    })
    .eq('id', notificationId);
  if (error) throw error;
}

// ── Real-time subscription (waiter dashboard) ────────────────────────────────

export type NotificationCallback = (row: WaiterGridRow) => void;

/**
 * Subscribes to new notification INSERTs scoped to this waiter's active
 * pairing IDs via a server-side Realtime filter.
 *
 * Using `pairing_id=in.(id1,id2,...)` as the filter pushes the scoping
 * work to Postgres, so only matching rows are sent over the wire —
 * consistent with how GeneratePairing.tsx filters requestor pairings.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToWaiterNotifications(
  pairingIds: string[],
  onNew: NotificationCallback
): () => void {
  if (!pairingIds.length) return () => {};

  // Build a server-side IN filter: pairing_id=in.(uuid1,uuid2,...)
  const filter = `pairing_id=in.(${pairingIds.join(',')})`;

  const channel = supabase
    .channel(`waiter-notifications-${Date.now()}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter,                       // ← server-side scoping, not client-side
      },
      async (payload) => {
        const row = payload.new as Notification;

        // Fetch table_name from the pairing (needed for the grid row)
        const { data: pairing } = await supabase
          .from('pairings')
          .select('table_name')
          .eq('id', row.pairing_id)
          .single();

        onNew({
          pairingId: row.pairing_id,
          tableName: pairing?.table_name ?? 'Unknown Table',
          latestNotificationId: row.id,
          notificationType: row.notification_type,
          requestMade: row.message,
          isActioned: row.is_actioned,
        });
      }
    )
    .subscribe((status, err) => {
      if (err) console.warn('[notificationService] Realtime error:', err);
      console.log('[notificationService] Realtime status:', status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
