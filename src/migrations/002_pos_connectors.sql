-- Direct POS integrations (Foodics, Oracle Simphony, manual reconciliation for POS without an API).

CREATE TABLE pos_connections (
  restaurant_id  uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('foodics','simphony','manual')),
  config         jsonb NOT NULL DEFAULT '{}',   -- non-secret settings (branch, rvc, tender ids...)
  secrets_enc    text,                          -- AES-GCM encrypted JSON (tokens). Never returned by the API.
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','error','disabled')),
  last_sync_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Single-use OAuth state (CSRF protection for the connect flow). Only the hash is stored.
CREATE TABLE oauth_states (
  state_hash     text PRIMARY KEY,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  expires_at     timestamptz NOT NULL
);

ALTER TABLE dining_tables
  ADD COLUMN external_id   text,    -- POS table id (Foodics)
  ADD COLUMN external_name text;    -- POS table name/number (Simphony)
CREATE UNIQUE INDEX dining_tables_external ON dining_tables(restaurant_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE bills
  ADD COLUMN source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','pos_api','foodics','simphony')),
  ADD COLUMN external_paid_minor bigint NOT NULL DEFAULT 0 CHECK (external_paid_minor >= 0), -- paid at the POS (cash etc.)
  ADD COLUMN synced_at           timestamptz;

-- Payments that must be recorded in the POS: automatically (with retries) or by staff.
CREATE TABLE pos_writebacks (
  payment_id      uuid PRIMARY KEY REFERENCES payments(id),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  mode            text NOT NULL CHECK (mode IN ('auto','manual')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  external_ref    text,
  done_by         uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz
);
CREATE INDEX ON pos_writebacks(status, next_attempt_at);
CREATE INDEX ON pos_writebacks(restaurant_id, status);
