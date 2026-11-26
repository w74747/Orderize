-- TEST-ONLY WhatsApp link via QR (personal number). Session keys give full access to the
-- linked WhatsApp account, so every value is stored encrypted (AES-256-GCM).
CREATE TABLE wa_web_auth (
  key        text PRIMARY KEY,
  value_enc  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
