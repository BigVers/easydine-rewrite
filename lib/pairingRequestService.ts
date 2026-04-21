// lib/pairingRequestService.ts
// Handles the waiter-side of the Option 1 pairing flow.
//
// When a patron scans a printed QR, a pairing_request row is inserted.
// The waiter sees it on their dashboard and taps Accept.
// This service provides:
//   - fetchPendingRequests() — load all pending requests for this branch
//   - subscribeToPairingRequests() — Realtime INSERT subscription
//   - acceptPairingRequest() — calls accept_pairing_request RPC

import { supabase } from './supabase';
import { getDeviceId } from './deviceService';

export interface PairingRequestRow {
  id: string;
  branchId: string;
  tableName: string;
  patronDeviceId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface AcceptResult {
  pairingId: string;
  tableName: string;
  branchId: string;
}

/**
 * Fetches all pending (non-expired) pairing requests for the given branch.
 */
export async function fetchPendingRequests(
  branchId: string
): Promise<PairingRequestRow[]> {
  const { data, error } = await supabase
    .from('pairing_requests')
    .select('id, branch_id, table_name, patron_device_id, status, created_at, expires_at')
    .eq('branch_id', branchId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    tableName: r.table_name,
    patronDeviceId: r.patron_device_id,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/**
 * Subscribes to new pairing_requests INSERTs for a given branch.
 * Returns an unsubscribe function.
 */
export function subscribeToPairingRequests(
  branchId: string,
  onNew: (row: PairingRequestRow) => void
): () => void {
  const channel = supabase
    .channel(`pairing-requests-branch-${branchId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'pairing_requests',
        filter: `branch_id=eq.${branchId}`,
      },
      (payload) => {
        const r = payload.new as any;
        // Only surface pending, non-expired requests
        if (r.status !== 'pending') return;
        if (new Date(r.expires_at) < new Date()) return;
        onNew({
          id: r.id,
          branchId: r.branch_id,
          tableName: r.table_name,
          patronDeviceId: r.patron_device_id,
          status: r.status,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        });
      }
    )
    .subscribe((status, err) => {
      if (err) console.warn('[pairingRequestService] Realtime error:', err);
      console.log('[pairingRequestService] Realtime status:', status);
    });

  return () => supabase.removeChannel(channel);
}

/**
 * Calls the accept_pairing_request RPC.
 * The RPC atomically creates the pairing and updates the request row.
 */
export async function acceptPairingRequest(
  requestId: string
): Promise<AcceptResult> {
  const receiverId = await getDeviceId();

  const { data, error } = await supabase.rpc('accept_pairing_request', {
    p_request_id: requestId,
    p_receiver_id: receiverId,
  });

  if (error) throw new Error(error.message);

  if (!data?.success) {
    const messages: Record<string, string> = {
      request_not_found: 'This request no longer exists.',
      request_not_pending: 'This request has already been accepted or expired.',
      request_expired: 'This request has expired.',
    };
    throw new Error(messages[data?.reason] ?? 'Could not accept request. Please try again.');
  }

  return {
    pairingId: data.pairing_id,
    tableName: data.table_name,
    branchId: data.branch_id,
  };
}
