-- Sufra core schema. Money is BIGINT minor units. IDs are random UUIDs (no enumeration).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE restaurants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  name_en          text NOT NULL,
  name_ar          text NOT NULL,
  country          char(2) NOT NULL CHECK (country IN ('AE','SA','QA','KW','BH','OM')),
  currency         char(3) NOT NULL CHECK (currency IN ('AED','SAR','QAR','KWD','BHD','OMR')),
  logo_url         text,
  cover_url        text,
  brand_color      text NOT NULL DEFAULT '#0b4f7c' CHECK (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  tip_percents     int[] NOT NULL DEFAULT '{5,7,10}',
  default_tip_percent int CHECK (default_tip_percent IS NULL OR default_tip_percent BETWEEN 0 AND 30),
  max_tip_percent  int NOT NULL DEFAULT 50 CHECK (max_tip_percent BETWEEN 0 AND 100),
  fee_bps          int NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_fixed_minor  bigint NOT NULL DEFAULT 0 CHECK (fee_fixed_minor >= 0),
  fee_cap_minor    bigint CHECK (fee_cap_minor IS NULL OR fee_cap_minor >= 0),
  menu             jsonb NOT NULL DEFAULT '[]',
  pos_key_hash     text,           -- sha256 of POS API key (key shown once)
  pos_secret_enc   text,           -- AES-GCM encrypted HMAC secret for POS signatures
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dining_tables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label          text NOT NULL,
  public_token   text UNIQUE NOT NULL CHECK (length(public_token) >= 22),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, label)
);

CREATE TABLE bills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id),
  table_id       uuid NOT NULL REFERENCES dining_tables(id),
  external_ref   text,
  currency       char(3) NOT NULL,
  total_minor    bigint NOT NULL CHECK (total_minor > 0),
  vat_minor      bigint NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  UNIQUE (restaurant_id, external_ref)
);
-- Only one open bill per table at a time.
CREATE UNIQUE INDEX one_open_bill_per_table ON bills(table_id) WHERE status = 'open';

CREATE TABLE bill_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  name_en           text NOT NULL,
  name_ar           text NOT NULL,
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
  qty               int NOT NULL CHECK (qty BETWEEN 1 AND 999),
  position          int NOT NULL DEFAULT 0
);
CREATE INDEX ON bill_items(bill_id);

CREATE TABLE offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid REFERENCES restaurants(id) ON DELETE CASCADE, -- NULL = platform-wide
  kind             text NOT NULL CHECK (kind IN ('percent','fixed')),
  value            bigint NOT NULL CHECK (value > 0),
  max_minor        bigint,
  min_spend_minor  bigint,
  currency         char(3),         -- required for fixed/max/min amounts
  title_en         text NOT NULL,
  title_ar         text NOT NULL,
  bank_name        text,
  theme            text NOT NULL DEFAULT 'dark',
  bin_prefixes     text[],          -- bank card offers: allowed BINs (6-8 digits)
  promo_code       text,            -- promo code offers (stored upper-case)
  max_redemptions  int,
  redemptions      int NOT NULL DEFAULT 0,
  starts_at        timestamptz,
  ends_at          timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK ((bin_prefixes IS NULL) <> (promo_code IS NULL))
);
CREATE UNIQUE INDEX offers_code ON offers(coalesce(restaurant_id::text,'*'), promo_code) WHERE promo_code IS NOT NULL;

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           uuid NOT NULL REFERENCES bills(id),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','captured','failed','expired','refunded')),
  currency          char(3) NOT NULL,
  share_minor       bigint NOT NULL CHECK (share_minor > 0),
  discount_minor    bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  fee_minor         bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  tip_minor         bigint NOT NULL DEFAULT 0 CHECK (tip_minor >= 0),
  total_minor       bigint NOT NULL CHECK (total_minor > 0),
  split             jsonb NOT NULL,
  items             jsonb,
  offer_id          uuid REFERENCES offers(id),
  allowed_bins      text[],
  provider          text NOT NULL,
  provider_ref      text,
  redirect_url      text,
  card_brand        text,
  card_last4        char(4),
  card_bin          text,
  flag              text,
  idempotency_key   text NOT NULL,
  request_hash      text NOT NULL,
  marketing_consent boolean NOT NULL DEFAULT false,
  client_ip         inet,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  captured_at       timestamptz,
  UNIQUE (bill_id, idempotency_key),
  CHECK (total_minor = share_minor - discount_minor + fee_minor + tip_minor)
);
CREATE INDEX ON payments(bill_id, status);
CREATE UNIQUE INDEX ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  email           text NOT NULL,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('platform_admin','owner','manager','staff')),
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  totp_last_step  bigint,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'platform_admin') = (restaurant_id IS NULL))
);
CREATE UNIQUE INDEX users_email ON users(lower(email));

CREATE TABLE sessions (
  id_hash     text PRIMARY KEY,   -- sha256(token); raw token only in the cookie
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_passed  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          inet,
  user_agent  text
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL,       -- user | diner | pos | provider | system
  actor_id      text,
  restaurant_id uuid,
  action        text NOT NULL,
  target        text,
  ip            inet,
  meta          jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON audit_log(restaurant_id, at DESC);

-- Append-only: block UPDATE/DELETE on the audit log at the database level.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE pos_nonces (
  restaurant_id uuid NOT NULL,
  nonce         text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, nonce)
);

CREATE TABLE outbox (
  id             bigserial PRIMARY KEY,
  restaurant_id  uuid NOT NULL,
  type           text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz
);
