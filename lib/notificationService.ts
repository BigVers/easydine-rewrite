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

  // Fire-and-forget: the Edge Function sends the actual push
  // We don't await it so the patron's UI stays snappy
  supabase.functions
    .invoke('send-notification', {
      body: { notificationId: notification.id, pairingId: payload.pairingId },
    })
    .catch((err) => console.warn('[notificationService] Edge Function error:', err));

  return notification as Notification;
}

// ── Reading (on waiter device / receiver) ────────────────────────────────────

/**
 * Fetches all active pairings for the current waiter device,
 * grouped with their latest notification, formatted for the dashboard grid.
 */
export async function getWaiterGridRows(): Promise<WaiterGridRow[]> {
  const receiverId = await getDeviceId();

  const { data: pairings, error: pairingError } = await supabase
    .from('pairings')
    .select('id, requestor_id, table_name')
    .eq('receiver_id', receiverId)
    .eq('is_active', true);

  if (pairingError) throw pairingError;
  if (!pairings?.length) return [];

  const pairingIds = pairings.map((p) => p.id);

  // Fetch latest notification per pairing (ordered by created_at desc)
  const { data: notifications, error: notifError } = await supabase
    .from('notifications')
    .select('id, pairing_id, notification_type, message, is_actioned, created_at')
    .in('pairing_id', pairingIds)
    .order('created_at', { ascending: false });

  if (notifError) throw notifError;

  // Group notifications by pairing, keep only the most recent per pairing
  const latestByPairing = new Map<string, (typeof notifications)[0]>();
  (notifications ?? []).forEach((n) => {
    if (!latestByPairing.has(n.pairing_id)) {
      latestByPairing.set(n.pairing_id, n);
    }
  });

  return pairings.map((p): WaiterGridRow => {
    const latest = latestByPairing.get(p.id) ?? null;
    return {
      pairingId: p.id,
      tableName: p.table_name,
      latestNotificationId: latest?.id ?? null,
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
 * Subscribes to new notifications for the current receiver's active pairings.
 * Returns an unsubscribe function.
 */
export function subscribeToWaiterNotifications(
  pairingIds: string[],
  onNew: NotificationCallback
): () => void {
  if (!pairingIds.length) return () => {};

  const channel = supabase
    .channel(`waiter-notifications-${Date.now()}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
      },
      async (payload) => {
        const row = payload.new as Notification;
        if (!pairingIds.includes(row.pairing_id)) return;

        // Fetch table_name from the pairing
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
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
