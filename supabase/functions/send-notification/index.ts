// supabase/functions/send-notification/index.ts
// Resolves receiver's OneSignal ID from DB then sends push via OneSignal REST API.

/// <reference path="../deno.d.ts" />
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ONESIGNAL_APP_ID       = Deno.env.get('ONESIGNAL_APP_ID') ?? '';
const ONESIGNAL_REST_API_KEY  = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? '';
const SUPABASE_URL            = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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
    const payload = await req.json();
    const { notificationId, pairingId } = payload;

    console.log('[send-notification] Received:', { notificationId, pairingId });

    // ── Validate env vars ────────────────────────────────────────────────────
    if (!ONESIGNAL_APP_ID)      { console.error('❌ ONESIGNAL_APP_ID not set');       return json({ error: 'ONESIGNAL_APP_ID secret missing' }, 500); }
    if (!ONESIGNAL_REST_API_KEY){ console.error('❌ ONESIGNAL_REST_API_KEY not set'); return json({ error: 'ONESIGNAL_REST_API_KEY secret missing' }, 500); }
    if (!SUPABASE_URL)          { console.error('❌ SUPABASE_URL not set');           return json({ error: 'SUPABASE_URL secret missing' }, 500); }
    if (!SUPABASE_SERVICE_KEY)  { console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set'); return json({ error: 'SUPABASE_SERVICE_ROLE_KEY secret missing' }, 500); }

    if (!notificationId || !pairingId) {
      console.error('❌ Missing notificationId or pairingId in request body');
      return json({ error: 'notificationId and pairingId are required' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── 1. Fetch notification ────────────────────────────────────────────────
    const { data: notif, error: notifErr } = await supabase
      .from('notifications')
      .select('notification_type, message')
      .eq('id', notificationId)
      .single();

    if (notifErr || !notif) {
      console.error('❌ Notification not found:', notifErr);
      return json({ error: 'Notification not found', detail: notifErr?.message }, 404);
    }
    console.log('[send-notification] Notification:', notif.notification_type, notif.message);

    // ── 2. Fetch pairing → receiver_id ──────────────────────────────────────
    const { data: pairing, error: pairingErr } = await supabase
      .from('pairings')
      .select('receiver_id, table_name')
      .eq('id', pairingId)
      .single();

    if (pairingErr || !pairing) {
      console.error('❌ Pairing not found:', pairingErr);
      return json({ error: 'Pairing not found', detail: pairingErr?.message }, 404);
    }
    console.log('[send-notification] Receiver device ID:', pairing.receiver_id);

    // ── 3. Fetch receiver's OneSignal subscription ID ────────────────────────
    const { data: device, error: deviceErr } = await supabase
      .from('devices')
      .select('onesignal_user_id, device_name, device_type')
      .eq('id', pairing.receiver_id)
      .single();

    if (deviceErr || !device) {
      console.error('❌ Receiver device row not found:', deviceErr);
      return json({ error: 'Receiver device not found', detail: deviceErr?.message }, 404);
    }

    console.log('[send-notification] Device row:', {
      type: device.device_type,
      name: device.device_name,
      onesignal_user_id: device.onesignal_user_id ?? 'NULL ← push will be skipped!',
    });

    if (!device.onesignal_user_id) {
      console.warn('⚠️  onesignal_user_id is NULL — receiver never saved their subscription ID. Push skipped.');
      return json({ success: false, reason: 'no_onesignal_id', receiver_id: pairing.receiver_id });
    }

    // ── 4. Build notification content ────────────────────────────────────────
    const TITLES: Record<string, string> = {
      NEW_ORDER:         '🍽️ New Order',
      BILL_REQUEST:      '🧾 Bill Requested',
      WAITER_REQUEST:    '🙋 Waiter Needed',
      CONDIMENT_REQUEST: '🧂 Condiments Requested',
      ORDER_UPDATE:      '📝 Order Update',
    };
    const title = TITLES[notif.notification_type] ?? 'EasyDine Request';
    const body  = `${pairing.table_name}: ${notif.message}`;

    console.log('[send-notification] Sending push:', { title, body, subscriptionId: device.onesignal_user_id });

    // ── 5. Call OneSignal REST API ────────────────────────────────────────────
    const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_subscription_ids: [device.onesignal_user_id],
        headings: { en: title },
        contents: { en: body },
        data: { notificationId, pairingId },
        priority: 10,
      }),
    });

    const osData = await osRes.json();
    console.log('[send-notification] OneSignal response:', osRes.status, JSON.stringify(osData));

    if (!osRes.ok) {
      console.error('❌ OneSignal API error:', osData);
      return json({ error: 'OneSignal API error', details: osData }, 502);
    }

    console.log('✅ Push sent successfully. OneSignal notification ID:', osData.id);
    return json({ success: true, onesignalId: osData.id });

  } catch (err) {
    console.error('[send-notification] Unexpected error:', err);
    return json({ error: 'Internal server error', detail: String(err) }, 500);
  }
});
