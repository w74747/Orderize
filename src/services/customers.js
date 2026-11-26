import crypto from 'node:crypto';
import { tx } from '../db.js';
import { hmacHex, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { normalizePhone } from '../lib/phone.js';
import { HttpError } from './bills.js';

const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 90;

const codeHash = (config, challengeId, code) => hmacHex(`otp:${config.APP_SECRET}`, `${challengeId}:${code}`);

export async function requestOtp(ctx, { country, phone, ip }) {
  const { pool, config, whatsapp } = ctx;
  const e164 = normalizePhone(country, phone);
  if (!e164) throw new HttpError(422, 'INVALID_PHONE');

  // Abuse limits: per number (3 / 10 min, 45 s between sends) and per IP (10 / hour).
  const { rows: [lim] } = await pool.query(
    `SELECT count(*) FILTER (WHERE phone_e164 = $1 AND created_at > now() - interval '10 minutes')::int AS by_phone,
            count(*) FILTER (WHERE phone_e164 = $1 AND created_at > now() - interval '45 seconds')::int AS recent,
            count(*) FILTER (WHERE ip = $2 AND created_at > now() - interval '1 hour')::int AS by_ip
       FROM otp_challenges WHERE created_at > now() - interval '1 hour'`,
    [e164, ip],
  );
  if (lim.recent > 0) throw new HttpError(429, 'OTP_WAIT');
  if (lim.by_phone >= 3 || lim.by_ip >= 10) throw new HttpError(429, 'RATE_LIMITED');
  const live = whatsapp.live;
  if (!live && !config.OTP_DEV_ECHO) throw new HttpError(503, 'WHATSAPP_NOT_CONFIGURED');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO otp_challenges(id, phone_e164, code_hash, ip, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
    [id, e164, codeHash(config, id, code), ip, OTP_TTL_MIN],
  );
  if (live) {
    const r = await whatsapp.sendOtp(e164, code);
    if (!r.sent) throw new HttpError(502, 'WHATSAPP_SEND_FAILED');
  }
  // The response never says whether this number already has an account.
  return {
    challenge_id: id,
    expires_in: OTP_TTL_MIN * 60,
    phone_hint: `${e164.slice(0, 4)}•••${e164.slice(-3)}`,
    ...(config.OTP_DEV_ECHO && !live ? { dev_code: code } : {}),
  };
}

export async function verifyOtp(ctx, { challengeId, code }) {
  const { pool, config } = ctx;
  if (!/^\d{6}$/.test(String(code))) throw new HttpError(422, 'INVALID_CODE');
  return tx(pool, async (db) => {
    const { rows: [ch] } = await db.query('SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
    if (!ch || ch.consumed_at || ch.expires_at < new Date() || ch.attempts >= OTP_MAX_ATTEMPTS) {
      throw new HttpError(422, 'CODE_EXPIRED');
    }
    await db.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
    if (!safeEqual(codeHash(config, ch.id, code), ch.code_hash)) {
      return { error: 'INVALID_CODE', attempts_left: OTP_MAX_ATTEMPTS - ch.attempts - 1 };
    }
    await db.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
    const { rows: [c] } = await db.query(
      `INSERT INTO customers(phone_e164) VALUES ($1)
       ON CONFLICT (phone_e164) DO UPDATE SET last_seen_at = now()
       RETURNING *`,
      [ch.phone_e164],
    );
    const token = randomToken(32);
    await db.query(
      `INSERT INTO customer_sessions(id_hash, customer_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`,
      [sha256(token), c.id, SESSION_DAYS],
    );
    return { token, customer: publicCustomer(c), needs_profile: !c.name };
  });
}

export function publicCustomer(c) {
  return {
    id: c.id, name: c.name, gender: c.gender,
    birth_date: c.birth_date ?? null,
    phone: c.phone_e164, marketing_consent: c.marketing_consent,
  };
}

export async function customerFromToken(pool, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await pool.query(
    `SELECT c.* FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND c.deleted_at IS NULL`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function updateProfile(pool, customerId, p) {
  const { rows: [c] } = await pool.query(
    `UPDATE customers SET name = $2, gender = $3, birth_date = $4, marketing_consent = $5, last_seen_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [customerId, p.name, p.gender, p.birth_date, p.marketing_consent],
  );
  return publicCustomer(c);
}

export async function accountView(pool, customer, decimalsOf) {
  const [points, coupons, orders] = await Promise.all([
    pool.query(
      `SELECT r.name_en, r.name_ar, r.slug, sum(l.points)::int AS points
         FROM loyalty_ledger l JOIN restaurants r ON r.id = l.restaurant_id
        WHERE l.customer_id = $1 GROUP BY r.id HAVING sum(l.points) <> 0 ORDER BY 4 DESC`,
      [customer.id],
    ),
    pool.query(
      `SELECT k.id, k.valid_until, c.name, c.kind, c.value, c.item_name, c.max_minor, c.min_spend_minor, c.audience,
              r.name_en AS restaurant_en, r.name_ar AS restaurant_ar, r.currency, r.slug
         FROM coupons k JOIN campaigns c ON c.id = k.campaign_id JOIN restaurants r ON r.id = k.restaurant_id
        WHERE k.customer_id = $1 AND k.status = 'available' AND k.valid_until > now() AND k.valid_from <= now()
        ORDER BY k.valid_until`,
      [customer.id],
    ),
    pool.query(
      `SELECT p.id, p.captured_at, p.currency, p.total_minor, p.share_minor, p.tip_minor, p.discount_minor,
              r.name_en, r.name_ar, l.points
         FROM payments p JOIN restaurants r ON r.id = p.restaurant_id
         LEFT JOIN loyalty_ledger l ON l.payment_id = p.id
        WHERE p.customer_id = $1 AND p.status = 'captured'
        ORDER BY p.captured_at DESC LIMIT 20`,
      [customer.id],
    ),
  ]);
  return { customer: publicCustomer(customer), points: points.rows, coupons: coupons.rows, orders: orders.rows };
}

/** Right to erasure: removes personal data, keeps anonymous payment records for accounting. */
export async function deleteAccount(pool, customerId) {
  await tx(pool, async (db) => {
    await db.query(
      `UPDATE customers SET phone_e164 = NULL, name = NULL, gender = NULL, birth_date = NULL,
              marketing_consent = false, deleted_at = now() WHERE id = $1`, [customerId],
    );
    await db.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);
    await db.query(`UPDATE coupons SET status = 'revoked' WHERE customer_id = $1 AND status = 'available'`, [customerId]);
  });
}
