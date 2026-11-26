-- Interactive menu (images, nutrition, options), branding, banners, table ordering,
-- paired order-station devices and waiter calls.

-- Media now also holds re-encoded images for logos, covers, items and banners.
ALTER TABLE media DROP CONSTRAINT IF EXISTS media_kind_check;
ALTER TABLE media ADD CONSTRAINT media_kind_check CHECK (kind IN ('menu_pdf','menu_image','logo','cover','item','banner'));
ALTER TABLE media ADD COLUMN width int, ADD COLUMN height int;

ALTER TABLE restaurants
  ADD COLUMN menu_mode            text NOT NULL DEFAULT 'browse' CHECK (menu_mode IN ('file','browse','order')),
  ADD COLUMN logo_media           uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN cover_media          uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN vat_bps              int NOT NULL DEFAULT 0 CHECK (vat_bps BETWEEN 0 AND 3000),  -- prices include VAT
  ADD COLUMN order_requires_login boolean NOT NULL DEFAULT false,
  ADD COLUMN waiter_call_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN translate_chars_day  date,
  ADD COLUMN translate_chars_used int NOT NULL DEFAULT 0;

-- Restaurants that already uploaded a menu file keep showing it.
UPDATE restaurants r SET menu_mode = 'file'
 WHERE EXISTS (SELECT 1 FROM media m WHERE m.restaurant_id = r.id AND m.kind IN ('menu_pdf','menu_image'));

ALTER TABLE menu_items
  ADD COLUMN image_id        uuid REFERENCES media(id) ON DELETE SET NULL,
  ADD COLUMN calories        int CHECK (calories BETWEEN 0 AND 20000),
  ADD COLUMN caffeine_mg     int CHECK (caffeine_mg BETWEEN 0 AND 2000),
  ADD COLUMN high_salt       boolean NOT NULL DEFAULT false,
  ADD COLUMN tags            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allergens       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN options         jsonb NOT NULL DEFAULT '[]',   -- [{id,name_en,name_ar,min,max,choices:[{id,name_en,name_ar,price_minor}]}]
  ADD COLUMN auto_translated text[] NOT NULL DEFAULT '{}';  -- fields filled by machine translation

CREATE TABLE menu_banners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  image_id      uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  title_en      text CHECK (length(title_en) <= 80),
  title_ar      text CHECK (length(title_ar) <= 80),
  link_type     text NOT NULL DEFAULT 'none' CHECK (link_type IN ('none','item','category')),
  link_id       uuid,
  starts_at     timestamptz,
  ends_at       timestamptz,
  active        boolean NOT NULL DEFAULT true,
  position      int NOT NULL DEFAULT 0,
  views         bigint NOT NULL DEFAULT 0,
  clicks        bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (link_type = 'none' OR link_id IS NOT NULL),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX ON menu_banners(restaurant_id, position);

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id       uuid NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  number         int NOT NULL,
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','ready','served','cancelled')),
  items          jsonb NOT NULL,       -- price snapshot computed by the server
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0),
  currency       char(3) NOT NULL,
  note           text CHECK (length(note) <= 300),
  cancel_reason  text CHECK (length(cancel_reason) <= 200),
  bill_id        uuid REFERENCES bills(id) ON DELETE SET NULL,
  pos_entry_needed boolean NOT NULL DEFAULT false,  -- POS-linked restaurant: staff key it into the POS
  client_key     text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  accepted_at    timestamptz,
  ready_at       timestamptz,
  served_at      timestamptz,
  cancelled_at   timestamptz,
  handled_by     text,
  UNIQUE (table_id, client_key)
);
CREATE INDEX ON orders(restaurant_id, status, created_at);
CREATE INDEX ON orders(table_id, created_at);

CREATE TABLE waiter_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('waiter','bill')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE UNIQUE INDEX one_open_call ON waiter_calls(table_id, kind) WHERE resolved_at IS NULL;

-- Order-station devices (a phone/tablet/Sunmi with printer). Paired once by a short-lived
-- single-use code shown as a QR; afterwards it holds a long random token (only its hash is stored).
CREATE TABLE order_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pair_code_hash  text,
  pair_expires_at timestamptz,
  token_hash      text UNIQUE,
  paired_at       timestamptz,
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_devices(restaurant_id);
