// lib/pairingService.ts
// Handles QR code generation (requestor/tablet side)
// and device pairing (receiver/waiter side).
//
// Business rules enforced:
//   - 1 requestor ↔ 1 receiver (unique active pairing per requestor)
//   - 1 receiver  ↔ N requestors
//   - Pairing is established by the RECEIVER scanning the requestor's QR code

import { supabase } from './supabase';
import { getDeviceId } from './deviceService';
import type { PairingCode, Pairing } from './types';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

/** Expected format: APP:EASYDINE:<CODE>:<REQUESTOR_UUID> */
const QR_PREFIX = 'APP:EASYDINE';

export function buildQRData(code: string, requestorId: string): string {
  return `${QR_PREFIX}:${code}:${requestorId}`;
}

export interface ParsedQR {
  code: string;
  requestorId: string;
}

export function parseQRData(raw: string): ParsedQR | null {
  const parts = raw.split(':');
  // "APP", "EASYDINE", <CODE>, <UUID>
  if (parts.length !== 4) return null;
  if (parts[0] !== 'APP' || parts[1] !== 'EASYDINE') return null;

  const code = parts[2];
  const requestorId = parts[3];

  const codeOk = /^[A-Z0-9]{6}$/.test(code);
  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestorId);

  if (!codeOk || !uuidOk) return null;
  return { code, requestorId };
}

// ── Requestor (tablet) side ──────────────────────────────────────────────────

export interface GeneratePairingResult {
  code: string;
  qrData: string;
  expiresAt: string;
  pairingCodeId: string;
}

/**
 * Generates a fresh pairing code + QR for the requestor tablet.
 * Invalidates any previously unused codes for this device.
 */
export async function generatePairingCode(
  tableName: string
): Promise<GeneratePairingResult> {
  if (!tableName?.trim()) throw new Error('Table name is required');

  const requestorId = await getDeviceId();

  // Invalidate unused codes for this requestor
  await supabase
    .from('pairing_codes')
    .update({ is_used: true, expires_at: new Date().toISOString() })
    .eq('requestor_id', requestorId)
    .eq('is_used', false);

  // Generate a unique code (retry up to 5 times on collision)
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode();
    const { data } = await supabase
      .from('pairing_codes')
      .select('id')
      .eq('code', code)
      .maybeSingle();
    if (!data) break; // code is unique
    if (attempt === 4) throw new Error('Failed to generate unique code, please try again');
  }

  const qrData = buildQRData(code, requestorId);
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('pairing_codes')
    .insert({
      requestor_id: requestorId,
      code,
      qr_code_data: qrData,
      table_name: tableName.trim(),
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (error) throw error;

  return { code, qrData, expiresAt, pairingCodeId: data.id };
}

// ── Receiver (waiter) side ───────────────────────────────────────────────────

export interface PairResult {
  pairingId: string;
  tableName: string;
}

/**
 * Called after the waiter scans a QR code (or enters a code manually).
 * Invokes the `pair_device` Postgres function which atomically:
 *   1. Validates the pairing code
 *   2. Deactivates any existing pairing for the requestor
 *   3. Creates a new active pairing
 *   4. Marks the code as used
 */
export async function pairWithRequestor(parsed: ParsedQR): Promise<PairResult> {
  const receiverId = await getDeviceId();

  const { data, error } = await supabase.rpc('pair_device', {
    p_requestor_id: parsed.requestorId,
    p_receiver_id: receiverId,
    p_pairing_code: parsed.code,
  });

  if (error) throw error;

  if (!data?.success) {
    const reason: string = data?.reason ?? 'unknown';
    const messages: Record<string, string> = {
      invalid_or_expired_code: 'This code is invalid or has expired. Please ask for a new QR code.',
    };
    throw new Error(messages[reason] ?? 'Pairing failed. Please try again.');
  }

  // Fetch the table name so we can redirect correctly
  const { data: pairing } = await supabase
    .from('pairings')
    .select('table_name')
    .eq('id', data.pairing_id)
    .single();

  return {
    pairingId: data.pairing_id,
    tableName: pairing?.table_name ?? 'Unknown Table',
  };
}

/**
 * Returns the active pairing ID for the current device (requestor side),
 * or null if this device is not currently paired.
 */
export async function getActivePairingId(): Promise<string | null> {
  const deviceId = await getDeviceId();
  const { data } = await supabase
    .from('pairings')
    .select('id')
    .eq('requestor_device_id', deviceId)
    .eq('is_active', true)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Closes a pairing session (called when the bill is paid).
 */
export async function deactivatePairing(pairingId: string): Promise<void> {
  const { error } = await supabase
    .from('pairings')
    .update({ is_active: false, unpaired_at: new Date().toISOString() })
    .eq('id', pairingId);
  if (error) throw error;
}
