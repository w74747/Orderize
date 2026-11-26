-- Platform administration (plans/subscriptions), diner accounts (WhatsApp OTP),
-- loyalty points, targeted coupons and post-payment ratings.

-- ---------- restaurant settings
ALTER TABLE restaurants
  ADD COLUMN google_review_url  text CHECK (google_review_url IS NULL OR google_review_url ~ '^https://'),
  ADD COLUMN require_phone      boolean NOT NULL DEFAULT true,
  ADD COLUMN loyalty_enabled    boolean NOT NULL DEFAULT true,
  ADD COLUMN points_per_unit    int NOT NULL DEFAULT 1 CHECK (points_per_unit BETWEEN 0 AND 1000); -- points per 1 major unit

-- ---------- plans & subscriptions (managed by the platform admin)
CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency    char(3) NOT NULL,
  interval    text NOT NULL CHECK (interval IN ('month','year')),
  features    jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  restaurant_id      uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id            uuid REFERENCES plans(id),
  status             text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  current_period_end date,
  notes              text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  currency      char(3) NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  status        text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','void')),
  reference     text,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON subscription_invoices(restaurant_id, created_at DESC);

-- ---------- diners (global across all restaurants)
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),  -- NULL after account deletion
  name              text,
  gender            text CHECK (gender IN ('male','female')),
  birth_date        date CHECK (birth_date IS NULL OR birth_date BETWEEN '1900-01-01' AND current_date),
  marketing_consent boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE TABLE otp_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  text NOT NULL,
  code_hash   text NOT NULL,          -- HMAC of the code; the code itself is never stored
  attempts    int NOT NULL DEFAULT 0,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenges(phone_e164, created_at DESC);

CREATE TABLE customer_sessions (
  id_hash     text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

ALTER TABLE payments ADD COLUMN customer_id uuid REFERENCES customers(id);
CREATE INDEX ON payments(customer_id, created_at DESC);

-- ---------- loyalty points (append-only ledger; balance = sum)
CREATE TABLE loyalty_ledger (
  id            bigserial PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  points        int NOT NULL CHECK (points <> 0),
  reason        text NOT NULL,
  payment_id    uuid UNIQUE REFERENCES payments(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON loyalty_ledger(restaurant_id, customer_id);

-- ---------- campaigns & coupons
CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('fixed','percent','free_item')),
  value           bigint NOT NULL CHECK (value > 0),          -- minor units (fixed / free item cap) or percent
  item_name       text,                                        -- free_item: which item
  max_minor       bigint,
  min_spend_minor bigint,
  audience        text NOT NULL CHECK (audience IN ('all','frequent','lapsed','birthday')),
  audience_param  int,                                         -- frequent: min visits; lapsed: days; birthday: days before
  valid_days      int NOT NULL DEFAULT 14 CHECK (valid_days BETWEEN 1 AND 365),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (kind <> 'free_item' OR item_name IS NOT NULL)
);

CREATE TABLE coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  issue_key           text NOT NULL,                           -- e.g. 'once' or birthday year: one coupon per key
  status              text NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed','revoked')),
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_until         timestamptz NOT NULL,
  redeemed_payment_id uuid REFERENCES payments(id),
  redeemed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, customer_id, issue_key)
);
CREATE INDEX ON coupons(customer_id, status);

ALTER TABLE payments ADD COLUMN coupon_id uuid REFERENCES coupons(id);

-- ---------- ratings
CREATE TABLE ratings (
  payment_id    uuid PRIMARY KEY REFERENCES payments(id),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  stars         int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment       text CHECK (length(comment) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ratings(restaurant_id, created_at DESC);

-- ---------- outbound WhatsApp log (no message content, phone stored hashed)
CREATE TABLE whatsapp_log (
  id         bigserial PRIMARY KEY,
  phone_hash text NOT NULL,
  template   text NOT NULL,
  status     text NOT NULL,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
