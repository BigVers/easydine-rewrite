// supabase/functions/send-notification/index.ts
// Edge Function: Sends a push notification via OneSignal.
// This keeps the OneSignal REST API key server-side.
//
// Called by the client via supabase.functions.invoke('send-notification', { body })

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const ONESIGNAL_APP_ID = Deno.env.get('ONESIGNAL_APP_ID') ?? '';
const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY') ?? '';

interface NotificationPayload {
  playerIds: string[];        // OneSignal player/subscription IDs
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const payload: NotificationPayload = await req.json();

    if (!payload.playerIds?.length) {
      return new Response(JSON.stringify({ error: 'playerIds is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Send via OneSignal REST API
    const osResponse = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: payload.playerIds,
        headings: { en: payload.title },
        contents: { en: payload.body },
        data: payload.data ?? {},
        // Ensure delivery even when app is backgrounded
        priority: 10,
        android_channel_id: 'easydine-requests',
      }),
    });

    const osData = await osResponse.json();

    if (!osResponse.ok) {
      console.error('[send-notification] OneSignal error:', osData);
      return new Response(
        JSON.stringify({ error: 'OneSignal API error', details: osData }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, id: osData.id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[send-notification] Unexpected error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
