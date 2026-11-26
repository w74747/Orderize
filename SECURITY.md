# Security model — Sufra

## Payments (PCI DSS)
- **No card data ever touches Sufra servers.** Every provider (Tap, Checkout.com) uses a hosted payment page, which keeps the platform in PCI DSS **SAQ-A** scope. We store only brand, BIN (first 6–8) and last 4 digits.
- **Amounts are computed only on the server** (`shared/billing.js`, integer minor units, 2 or 3 decimals per currency). Request schemas are strict: any extra field such as `amount` is rejected.
- **Webhooks:** HMAC signature checked with constant-time compare, then the payment is **re-fetched from the provider API** and that response is trusted. Amount/currency mismatches are flagged and never mark a bill as paid. Events are de-duplicated (`webhook_events`).
- **No over-payment:** the bill row is locked (`SELECT … FOR UPDATE`) while a payment is reserved. Reservations count toward the bill for `RESERVATION_TTL_MIN`.
- **Idempotency keys** on payment creation: a double tap or a network retry can never charge twice. Reusing a key with a different body returns 409.
- **Bank offers** are restricted to the offer's BIN ranges on the hosted page and re-verified on capture (`bin_mismatch` flag).
- **3-D Secure** is requested on every charge.

## Restaurant dashboard
- Passwords: scrypt (N=2^15), per-user salt. Constant-time verification with a dummy hash for unknown users (no user enumeration).
- Lockout after 5 failed attempts (15 min) + per-IP rate limit on login.
- TOTP 2FA (RFC 6238) with replay protection; enforce for everyone with `REQUIRE_2FA=true`. TOTP seeds are encrypted at rest (AES-256-GCM).
- Sessions: 256-bit random token, only its SHA-256 is stored; `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; 30-min idle and 12-h absolute expiry.
- CSRF: SameSite=Strict + exact `Origin` check + JSON-only bodies on every state change.
- Role-based access (staff < manager < owner) and **tenant isolation** on every query (`restaurant_id` scoping).

## Table QR codes
- 144-bit random, unguessable tokens (not sequential IDs). One click rotates a token, which invalidates a copied sticker.
- `Referrer-Policy: no-referrer` so tokens never leak to third parties.

## POS integration
- Requests are signed with HMAC-SHA256 over timestamp + nonce + method + path + body; ±5-minute window; nonces are single-use (replay protection).
- POS secrets are stored encrypted; the API key is stored hashed and shown once.
- Paid events are **pulled** by the POS — the server never calls arbitrary URLs (no SSRF surface).

## Platform
- Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS preload in production, `nosniff`, no framing.
- The UI never uses `innerHTML` with data (XSS-safe by construction).
- All SQL is parameterized. The append-only audit log is enforced by a database trigger.
- Errors return codes only; stack traces and SQL never reach clients. Logs redact cookies, signatures and keys.
- Config is validated at boot: production refuses sandbox payments, insecure cookies or non-HTTPS URLs.
- Non-root Docker image; `npm audit` in CI.

## Before going live (checklist)
1. Keep provider live keys in the platform's secret store, never in git. Note: changing `APP_SECRET` makes the stored TOTP and POS secrets unreadable, so add key versioning (or a KMS) before you rotate it.
2. Postgres: TLS (`sslmode=require`), a least-privilege app role (no `DROP`/`TRUNCATE`), point-in-time backups, encrypted at rest.
3. WAF/CDN in front (Cloudflare or similar) with bot protection on `/api/t/*/payments`.
4. Annual external penetration test plus PCI SAQ-A attestation.
5. Data residency: check each country's rules (e.g. Saudi PDPL, UAE PDPL, Oman PDPL) on where diner data may be hosted.
6. Alerts on `payments.flag IS NOT NULL` (mismatch, overpaid, bin_mismatch).

## Diner accounts (WhatsApp sign-in)
- 6-digit codes from a CSPRNG, stored only as an HMAC, valid 5 minutes, max 5 attempts, single use.
- Limits: 1 code per 45 s and 3 per 10 min per number, 10 per hour per IP, plus route rate limits.
- The sign-in response never reveals whether a number already has an account.
- Diner session: 256-bit token (hash stored), `HttpOnly`, `Secure`, `SameSite=Lax`, 90 days; Origin check on every state change.
- Restaurants never see full phone numbers (masked) and can only target diners who paid at **their** restaurant.
- Marketing messages only to diners who opted in. Account deletion erases name, phone, gender and birth date and revokes coupons.
- `OTP_DEV_ECHO` (returns the code in the response) is a demo-only switch: refused when WhatsApp is configured or in real production.

## Coupons, points, ratings
- Coupons belong to one diner and one restaurant, are locked during payment and redeemed atomically on capture (no double use).
- One discount per payment (bank offer, promo code or coupon). Points are an append-only ledger, one entry per payment.
- One rating per payment, by its own diner, within 48 h. The Google review invitation is shown to every diner regardless of rating (Google forbids review gating).

## Platform console
- Platform admins are a separate role with 2FA always required (`PLATFORM_REQUIRE_2FA`).
- Suspending a restaurant switches off its QR codes and signs its staff out. Temporary owner passwords are shown once.
