-- Restaurant-managed menu (for restaurants without a POS) + uploaded menu files.

CREATE TABLE menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name_en       text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 80),
  name_ar       text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 80),
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON menu_categories(restaurant_id, position);

CREATE TABLE menu_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id    uuid NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  name_en        text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  name_ar        text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  description_en text CHECK (length(description_en) <= 300),
  description_ar text CHECK (length(description_ar) <= 300),
  price_minor    bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  available      boolean NOT NULL DEFAULT true,
  position       int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON menu_items(restaurant_id, category_id, position);

-- Uploaded files are stored in the database (small, per-restaurant menus) and served
-- by random id. Type is decided by the file's magic bytes, never by its name.
CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('menu_pdf','menu_image')),
  mime          text NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png','image/webp')),
  bytes         bytea NOT NULL,
  size          int NOT NULL CHECK (size > 0 AND size <= 10485760),
  sha256        text NOT NULL,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media(restaurant_id, kind, position);
