// supabase/functions/notify-pairing-request/index.ts
// Called by the web app when a patron scans a printed table QR.
// Looks up all ACTIVE receiver devices for the branch and sends
// a OneSignal push to each one: "Table 5 needs service — tap to accept."

/// <reference path="../deno.d.ts" />
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ONESIGNAL_APP_ID      = Deno.env.get('ONESIGNAL_APP_ID') ?? '';
const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? '';
const SUPABASE_URL           = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { requestId, branchId, tableName } = await req.json();

    if (!requestId || !branchId || !tableName) {
      return json({ error: 'requestId, branchId and tableName are required' }, 400);
    }

    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return json({ error: 'Missing environment secrets' }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Find all active receiver devices on this branch that have a OneSignal ID
    const { data: devices, error: devErr } = await supabase
      .from('devices')
      .select('id, onesignal_user_id, device_name')
      .eq('branch_id', branchId)
      .eq('device_type', 'receiver')
      .eq('is_active', true)
      .not('onesignal_user_id', 'is', null);

    if (devErr) {
      console.error('[notify-pairing-request] device fetch error:', devErr);
      return json({ error: 'Could not fetch waiter devices', detail: devErr.message }, 500);
    }

    if (!devices?.length) {
      console.warn('[notify-pairing-request] No active receiver devices with OneSignal ID for branch:', branchId);
      return json({ success: false, reason: 'no_active_waiters' });
    }

    const subscriptionIds = devices.map((d: any) => d.onesignal_user_id);
    console.log(`[notify-pairing-request] Pushing to ${subscriptionIds.length} waiter(s) for ${tableName}`);

    const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_subscription_ids: subscriptionIds,
        headings: { en: '🪑 Table Needs Service' },
        contents: { en: `${tableName} — a patron is waiting. Tap to accept.` },
        data: { requestId, branchId, tableName, type: 'PAIRING_REQUEST' },
        priority: 10,
      }),
    });

    const osData = await osRes.json();

    if (!osRes.ok) {
      console.error('[notify-pairing-request] OneSignal error:', osData);
      return json({ error: 'OneSignal API error', details: osData }, 502);
    }

    console.log('[notify-pairing-request] Push sent. OneSignal ID:', osData.id);
    return json({ success: true, onesignalId: osData.id, waiterCount: subscriptionIds.length });

  } catch (err) {
    console.error('[notify-pairing-request] Unexpected error:', err);
    return json({ error: 'Internal server error', detail: String(err) }, 500);
  }
});
