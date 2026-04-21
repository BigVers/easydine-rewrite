-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: pairing_requests
--
-- This table powers the "patron scans printed QR → waiter gets push → waiter
-- accepts → patron opens mobile menu" flow.
--
-- Flow:
--   1. Patron scans printed QR code (encodes branch_id + table_name)
--   2. Web app inserts a row here with status = 'pending'
--   3. Supabase send-notification Edge Function pushes to ALL active waiter
--      devices on the branch ("Table 5 needs service")
--   4. Waiter taps Accept in mobile app → status = 'accepted', pairing_id set
--   5. Web app Realtime listener detects the update → opens easydine://menu
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.pairing_requests (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references public.branches(id),
  table_name        text not null,
  patron_device_id  text not null,          -- web browser localStorage UUID
  status            text not null default 'pending'
                      check (status in ('pending','accepted','rejected','expired')),
  pairing_id        uuid references public.pairings(id),  -- filled on accept
  accepted_by       text,                   -- waiter device_id who accepted
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '15 minutes')
);

-- Index for the waiter dashboard query (branch + pending)
create index if not exists pairing_requests_branch_status_idx
  on public.pairing_requests (branch_id, status);

-- Index for the web app Realtime subscription (patron polls own request)
create index if not exists pairing_requests_patron_idx
  on public.pairing_requests (patron_device_id, status);

-- Auto-update updated_at on every change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pairing_requests_set_updated_at on public.pairing_requests;
create trigger pairing_requests_set_updated_at
  before update on public.pairing_requests
  for each row execute function public.set_updated_at();

-- Enable Realtime on this table (required for web app subscription)
alter publication supabase_realtime add table public.pairing_requests;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: accept_pairing_request
--
-- Called by the waiter's mobile app when they tap Accept.
-- Atomically:
--   1. Validates the request is still pending and not expired
--   2. Marks any existing active pairing for this patron device as inactive
--   3. Creates a new pairing row
--   4. Updates the pairing_request to accepted + stores pairing_id
--
-- Returns: { success, pairing_id, table_name, error_reason }
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.accept_pairing_request(
  p_request_id  uuid,
  p_receiver_id text    -- waiter's device_id
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_request     public.pairing_requests%rowtype;
  v_pairing_id  uuid;
begin
  -- 1. Lock and fetch the request
  select * into v_request
  from public.pairing_requests
  where id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'reason', 'request_not_found');
  end if;

  if v_request.status <> 'pending' then
    return jsonb_build_object('success', false, 'reason', 'request_not_pending',
                              'current_status', v_request.status);
  end if;

  if v_request.expires_at < now() then
    update public.pairing_requests set status = 'expired' where id = p_request_id;
    return jsonb_build_object('success', false, 'reason', 'request_expired');
  end if;

  -- 2. Deactivate any existing pairing for this patron device
  update public.pairings
  set is_active = false,
      unpaired_at = now()
  where requestor_id = v_request.patron_device_id
    and is_active = true;

  -- 3. Create the new pairing
  insert into public.pairings (
    branch_id,
    requestor_id,
    receiver_id,
    table_name,
    is_active,
    paired_at
  ) values (
    v_request.branch_id,
    v_request.patron_device_id,
    p_receiver_id,
    v_request.table_name,
    true,
    now()
  )
  returning id into v_pairing_id;

  -- 4. Mark the request as accepted
  update public.pairing_requests
  set status      = 'accepted',
      pairing_id  = v_pairing_id,
      accepted_by = p_receiver_id
  where id = p_request_id;

  return jsonb_build_object(
    'success',     true,
    'pairing_id',  v_pairing_id,
    'table_name',  v_request.table_name,
    'branch_id',   v_request.branch_id
  );
end;
$$;
