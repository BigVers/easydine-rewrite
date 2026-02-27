-- ============================================================
-- EasyDine Database Schema
-- Multi-restaurant, QR-paired dining automation platform
-- ============================================================

-- ─────────────────────────────────────────
-- UTILITY: auto-update updated_at columns
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────
-- RESTAURANTS
-- Top-level entity (Spur, Ocean Basket, etc.)
-- ─────────────────────────────────────────
CREATE TABLE public.restaurants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  slug         TEXT        UNIQUE NOT NULL,   -- e.g. "spur", "ocean-basket"
  logo_url     TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_restaurants_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- BRANCHES
-- Individual restaurant locations
-- ─────────────────────────────────────────
CREATE TABLE public.branches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  address          TEXT,
  phone            TEXT,
  email            TEXT,
  timezone         TEXT        NOT NULL DEFAULT 'Africa/Johannesburg',
  operating_hours  JSONB,         -- { "mon": { "open": "08:00", "close": "22:00" }, ... }
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_branches_restaurant_id ON branches(restaurant_id);
CREATE INDEX idx_branches_active       ON branches(is_active) WHERE is_active;

CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- RESTAURANT CUSTOMISATION
-- Per-branch theming (colors, fonts, logo)
-- Drives the "physical menu" look per brand
-- ─────────────────────────────────────────
CREATE TABLE public.restaurant_customisations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        UUID        NOT NULL UNIQUE REFERENCES branches(id) ON DELETE CASCADE,
  primary_color    TEXT        NOT NULL DEFAULT '#8B0000',
  secondary_color  TEXT        NOT NULL DEFAULT '#FFDEAD',
  background_color TEXT        NOT NULL DEFAULT '#FFFFFF',
  text_color       TEXT        NOT NULL DEFAULT '#212121',
  font_family      TEXT        NOT NULL DEFAULT 'System',
  logo_url         TEXT,
  banner_url       TEXT,
  border_radius    INTEGER     NOT NULL DEFAULT 8,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_customisations_updated_at
  BEFORE UPDATE ON restaurant_customisations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- STAFF / USER PROFILES
-- Waiters, managers, admins
-- ─────────────────────────────────────────
CREATE TABLE public.user_profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  restaurant_id   UUID        REFERENCES restaurants(id),
  branch_id       UUID        REFERENCES branches(id),
  full_name       TEXT        NOT NULL,
  email           TEXT        NOT NULL UNIQUE,
  phone           TEXT,
  role            TEXT        NOT NULL DEFAULT 'waiter'
                  CHECK (role IN ('waiter','manager','admin','super_admin')),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_profiles_restaurant_id ON user_profiles(restaurant_id);
CREATE INDEX idx_user_profiles_branch_id     ON user_profiles(branch_id);
CREATE INDEX idx_user_profiles_role          ON user_profiles(role);
CREATE INDEX idx_user_profiles_active        ON user_profiles(is_active) WHERE is_active;

CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- TABLES
-- Physical dining tables within a branch
-- ─────────────────────────────────────────
CREATE TABLE public.tables (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  table_number         TEXT        NOT NULL,
  capacity             INTEGER     NOT NULL DEFAULT 4 CHECK (capacity > 0),
  location_description TEXT,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_table_per_branch UNIQUE (branch_id, table_number)
);

CREATE INDEX idx_tables_branch_id ON tables(branch_id);
CREATE INDEX idx_tables_active    ON tables(is_active) WHERE is_active;

CREATE TRIGGER trg_tables_updated_at
  BEFORE UPDATE ON tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- DEVICES
-- Requestor = patron tablet at a table
-- Receiver  = waiter mobile device
-- Business rule: 1 requestor → 1 receiver; 1 receiver → many requestors
-- ─────────────────────────────────────────
CREATE TABLE public.devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         UUID        REFERENCES branches(id) ON DELETE SET NULL,
  device_name       TEXT        NOT NULL,
  device_type       TEXT        NOT NULL CHECK (device_type IN ('requestor','receiver')),
  onesignal_user_id TEXT,                   -- OneSignal player ID for push delivery
  device_info       JSONB,                  -- OS, model, app version, etc.
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_devices_branch_id       ON devices(branch_id);
CREATE INDEX idx_devices_device_type     ON devices(device_type);
CREATE INDEX idx_devices_onesignal_id    ON devices(onesignal_user_id);
CREATE INDEX idx_devices_active          ON devices(is_active) WHERE is_active;

CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- PAIRING CODES
-- Time-limited QR codes generated by requestor (tablet)
-- Scanned by receiver (waiter) to link the two devices
-- ─────────────────────────────────────────
CREATE TABLE public.pairing_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requestor_id  UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code          TEXT        NOT NULL UNIQUE,
  qr_code_data  TEXT        NOT NULL,
  table_name    TEXT        NOT NULL,    -- e.g. "Table 5" — set when code is generated
  is_used       BOOLEAN     NOT NULL DEFAULT FALSE,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 hours'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pairing_codes_code        ON pairing_codes(code);
CREATE INDEX idx_pairing_codes_requestor   ON pairing_codes(requestor_id);
CREATE INDEX idx_pairing_codes_active      ON pairing_codes(expires_at) WHERE NOT is_used;

-- ─────────────────────────────────────────
-- PAIRINGS
-- Active link between a requestor and a receiver
-- One requestor can only have one active receiver at a time
-- One receiver can be linked to many requestors simultaneously
-- ─────────────────────────────────────────
CREATE TABLE public.pairings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID        REFERENCES branches(id) ON DELETE SET NULL,
  requestor_id  UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  receiver_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  table_name    TEXT        NOT NULL,    -- label displayed in waiter dashboard
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  paired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unpaired_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_different_devices CHECK (requestor_id <> receiver_id)
);

-- Enforce: one active pairing per requestor
CREATE UNIQUE INDEX uq_active_requestor
  ON pairings(requestor_id) WHERE is_active;

CREATE INDEX idx_pairings_receiver_active  ON pairings(receiver_id, is_active);
CREATE INDEX idx_pairings_requestor        ON pairings(requestor_id);
CREATE INDEX idx_pairings_branch_id        ON pairings(branch_id);

CREATE TRIGGER trg_pairings_updated_at
  BEFORE UPDATE ON pairings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────
-- MENUS + CATEGORIES + ITEMS
-- ─────────────────────────────────────────
CREATE TABLE public.menus (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID        REFERENCES branches(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id      UUID        NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  display_order INTEGER    NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.menu_items (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id                  UUID        NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  category_id              UUID        REFERENCES categories(id) ON DELETE SET NULL,
  name                     TEXT        NOT NULL,
  description              TEXT,
  price                    NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  image_url                TEXT,
  is_available             BOOLEAN     NOT NULL DEFAULT TRUE,
  is_addon                 BOOLEAN     NOT NULL DEFAULT FALSE,
  allergens                TEXT[],
  dietary_tags             TEXT[],
  preparation_time_minutes INTEGER,
  display_order            INTEGER     NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menu_items_menu_id     ON menu_items(menu_id);
CREATE INDEX idx_menu_items_category_id ON menu_items(category_id);
CREATE INDEX idx_menu_items_available   ON menu_items(is_available) WHERE is_available;

CREATE TRIGGER trg_menu_items_updated_at
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Extras (up-sell items linked to a menu)
CREATE TABLE public.extras (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id  UUID        NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  name     TEXT        NOT NULL,
  price    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0)
);

-- Condiments offered at a branch
CREATE TABLE public.condiments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  description   TEXT,
  price         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_available  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_condiments_branch_id ON condiments(branch_id);
CREATE INDEX idx_condiments_available ON condiments(is_available) WHERE is_available;

-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- Push events sent from patron tablet → waiter device
-- ─────────────────────────────────────────
CREATE TABLE public.notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id        UUID        NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
  notification_type TEXT        NOT NULL
                    CHECK (notification_type IN (
                      'NEW_ORDER','BILL_REQUEST','WAITER_REQUEST',
                      'CONDIMENT_REQUEST','ORDER_UPDATE'
                    )),
  message           TEXT        NOT NULL,
  is_actioned       BOOLEAN     NOT NULL DEFAULT FALSE,
  actioned_at       TIMESTAMPTZ,
  actioned_by       UUID        REFERENCES devices(id),  -- the receiver that actioned it
  metadata          JSONB,                               -- order details, condiment list, etc.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_pairing_id ON notifications(pairing_id);
CREATE INDEX idx_notifications_type       ON notifications(notification_type);
CREATE INDEX idx_notifications_actioned   ON notifications(is_actioned) WHERE NOT is_actioned;
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- ─────────────────────────────────────────
-- ORDERS
-- ─────────────────────────────────────────
CREATE TABLE public.orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id    UUID        REFERENCES pairings(id) ON DELETE SET NULL,
  branch_id     UUID        NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  table_name    TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','preparing','ready','served','cancelled')),
  total_amount  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  notes         TEXT,
  order_number  TEXT        UNIQUE,    -- human-readable (auto-generated)
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at  TIMESTAMPTZ,
  ready_at      TIMESTAMPTZ,
  served_at     TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_pairing_id  ON orders(pairing_id);
CREATE INDEX idx_orders_branch_id   ON orders(branch_id);
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_placed_at   ON orders(placed_at DESC);

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE public.order_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id         UUID        NOT NULL REFERENCES menu_items(id),
  quantity             INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price           NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  subtotal             NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  special_instructions TEXT,
  extras               JSONB,        -- [{id, name, unit_price}]
  condiments           JSONB,        -- [{condiment_id, name, unit_price}]
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX idx_order_items_menu_item_id ON order_items(menu_item_id);

-- ─────────────────────────────────────────
-- BILLS & PAYMENTS
-- ─────────────────────────────────────────
CREATE TABLE public.bills (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id   UUID        REFERENCES pairings(id) ON DELETE SET NULL,
  branch_id    UUID        NOT NULL REFERENCES branches(id),
  table_name   TEXT        NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status       TEXT        NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','PAID','CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bills_pairing_id ON bills(pairing_id);
CREATE INDEX idx_bills_status     ON bills(status);

CREATE TRIGGER trg_bills_updated_at
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- When bill is paid → close the pairing session
CREATE OR REPLACE FUNCTION close_pairing_on_bill_paid()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'PAID' AND NEW.pairing_id IS NOT NULL THEN
    UPDATE pairings
    SET is_active   = FALSE,
        unpaired_at = NOW()
    WHERE id = NEW.pairing_id AND is_active;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_close_pairing_on_bill_paid
  AFTER UPDATE OF status ON bills
  FOR EACH ROW
  WHEN (OLD.status <> 'PAID' AND NEW.status = 'PAID')
  EXECUTE FUNCTION close_pairing_on_bill_paid();

-- ─────────────────────────────────────────
-- PAIR_DEVICE stored procedure
-- Called by receiver (waiter) after scanning QR
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION pair_device(
  p_requestor_id   UUID,
  p_receiver_id    UUID,
  p_pairing_code   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code          pairing_codes%ROWTYPE;
  v_pairing_id    UUID;
BEGIN
  -- 1. Validate pairing code
  SELECT * INTO v_code
  FROM pairing_codes
  WHERE code = p_pairing_code
    AND requestor_id = p_requestor_id
    AND NOT is_used
    AND expires_at > NOW();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'reason', 'invalid_or_expired_code');
  END IF;

  -- 2. Deactivate any existing active pairing for this requestor
  UPDATE pairings
  SET is_active   = FALSE,
      unpaired_at = NOW()
  WHERE requestor_id = p_requestor_id AND is_active;

  -- 3. Create the new pairing
  INSERT INTO pairings (requestor_id, receiver_id, table_name, is_active)
  VALUES (p_requestor_id, p_receiver_id, v_code.table_name, TRUE)
  RETURNING id INTO v_pairing_id;

  -- 4. Mark the code as used
  UPDATE pairing_codes SET is_used = TRUE WHERE id = v_code.id;

  RETURN jsonb_build_object('success', TRUE, 'pairing_id', v_pairing_id);
END;
$$;
