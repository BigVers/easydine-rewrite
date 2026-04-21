-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: static table QR pairing
--
-- Adds support for the printed-QR-per-table flow:
--
--   1. Waiter scans table QR → register_receiver_for_table() stores their
--      device_id as the on-duty receiver for that branch+table combination.
--
--   2. Patron scans same QR → web app calls pair_table() which finds the
--      active receiver for that branch+table and creates a pairing row.
--
-- QR format: TABLE:EASYDINE:<branch_id>:<table_name>
-- ─────────────────────────────────────────────────────────────────────────────

-- Add assigned_table_name to devices so we can look up which waiter
-- is currently serving a given table.
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS assigned_table_name TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_table_assignment
  ON public.devices (branch_id, assigned_table_name)
  WHERE device_type = 'receiver' AND is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: register_receiver_for_table
--
-- Called by the WAITER when they scan a printed table QR.
-- Stores branch_id + table_name on their device row so the patron's
-- web app can find them later.
--
-- Returns: { success, device_id }
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_receiver_for_table(
  p_receiver_id   TEXT,    -- waiter's device UUID (text, cast below)
  p_branch_id     UUID,
  p_table_name    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.devices
  SET
    branch_id           = p_branch_id,
    assigned_table_name = p_table_name,
    device_type         = 'receiver',
    last_seen_at        = NOW()
  WHERE id::text = p_receiver_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'device_not_found');
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'device_id', p_receiver_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: pair_table
--
-- Called by the PATRON's web app after they scan a printed table QR.
-- Finds the active receiver device assigned to branch+table, then
-- creates a pairing atomically.
--
-- Returns: { success, pairing_id, table_name, receiver_id, reason? }
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pair_table(
  p_patron_device_id  TEXT,   -- patron's browser UUID
  p_branch_id         UUID,
  p_table_name        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_receiver_id   TEXT;
  v_pairing_id    UUID;
BEGIN
  -- 1. Find the active receiver assigned to this table
  SELECT id::text INTO v_receiver_id
  FROM public.devices
  WHERE branch_id           = p_branch_id
    AND assigned_table_name = p_table_name
    AND device_type         = 'receiver'
    AND is_active           = TRUE
  ORDER BY last_seen_at DESC
  LIMIT 1;

  IF v_receiver_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'reason',  'no_receiver_for_table'
    );
  END IF;

  -- 2. Ensure patron device exists (upsert safe defaults)
  INSERT INTO public.devices (id, device_type, device_name, branch_id, is_active, last_seen_at)
  VALUES (
    p_patron_device_id::uuid,
    'requestor',
    'Patron Phone (Web)',
    p_branch_id,
    TRUE,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    SET branch_id    = p_branch_id,
        last_seen_at = NOW();

  -- 3. Deactivate any existing pairing for this patron
  UPDATE public.pairings
  SET is_active   = FALSE,
      unpaired_at = NOW()
  WHERE requestor_id::text = p_patron_device_id
    AND is_active = TRUE;

  -- 4. Create the new pairing
  INSERT INTO public.pairings (
    branch_id,
    requestor_id,
    receiver_id,
    table_name,
    is_active,
    paired_at
  ) VALUES (
    p_branch_id,
    p_patron_device_id::uuid,
    v_receiver_id::uuid,
    p_table_name,
    TRUE,
    NOW()
  )
  RETURNING id INTO v_pairing_id;

  RETURN jsonb_build_object(
    'success',     TRUE,
    'pairing_id',  v_pairing_id,
    'table_name',  p_table_name,
    'receiver_id', v_receiver_id
  );
END;
$$;
