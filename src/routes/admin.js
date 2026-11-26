import QRCode from 'qrcode';
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { base32Encode, randomToken, sha256, verifyTotp } from '../lib/crypto.js';
import { HttpError } from '../services/bills.js';
import { login, logout, publicUser, ROLE_RANK, sessionUser } from '../services/auth.js';
import * as S from './schemas.js';
import crypto from 'node:crypto';

export default async function adminRoutes(app, { ctx }) {
  const { pool, config, cipher } = ctx;
  const COOKIE = config.COOKIE_SECURE ? '__Host-sufra_sid' : 'sufra_sid';
  const origin = new URL(config.PUBLIC_BASE_URL).origin;
  const cookieOpts = { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict' };

  // CSRF defence (on top of SameSite=Strict): state-changing requests must come from our own origin
  // and be JSON (which forces a CORS preflight from any foreign site).
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers.origin !== origin) throw new HttpError(403, 'BAD_ORIGIN');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON_ONLY');
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const auth = (minRole = 'staff', { allowNoMfa = false } = {}) => async (req) => {
    const u = await sessionUser(pool, req.cookies[COOKIE]);
    if (!u) throw new HttpError(401, 'UNAUTHENTICATED');
    if (config.REQUIRE_2FA && !allowNoMfa && !(u.totp_enabled && u.mfa_passed)) throw new HttpError(403, 'MFA_SETUP_REQUIRED');
    if (ROLE_RANK[u.role] < ROLE_RANK[minRole]) throw new HttpError(403, 'FORBIDDEN');
    req.user = u;
  };
  const rid = (req) => {
    if (!req.user.restaurant_id) throw new HttpError(400, 'NO_RESTAURANT');
    return req.user.restaurant_id;
  };

  // ---------- auth
  app.post('/api/admin/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = S.login.parse(req.body);
    const { token, user } = await login(ctx, { ...body, ip: req.ip, ua: req.headers['user-agent'] });
    reply.setCookie(COOKIE, token, { ...cookieOpts, maxAge: 12 * 3600 });
    return { user };
  });

  app.post('/api/admin/logout', async (req, reply) => {
    await logout(pool, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/api/admin/me', { preHandler: auth('staff', { allowNoMfa: true }) }, async (req) => ({
    user: publicUser(req.user),
    mfa_required: config.REQUIRE_2FA && !(req.user.totp_enabled && req.user.mfa_passed),
  }));

  app.post('/api/admin/2fa/setup', { preHandler: auth('staff', { allowNoMfa: true }) }, async (req) => {
    if (req.user.totp_enabled) throw new HttpError(409, 'ALREADY_ENABLED');
    const secret = base32Encode(crypto.randomBytes(20));
    await pool.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user.id, cipher.encrypt(secret)]);
    const uri = `otpauth://totp/Sufra:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=Sufra`;
    return { secret, otpauth_uri: uri, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1 }) };
  });

  app.post('/api/admin/2fa/enable', { preHandler: auth('staff', { allowNoMfa: true }) }, async (req) => {
    const code = String(req.body?.code ?? '');
    if (!req.user.totp_secret_enc) throw new HttpError(400, 'SETUP_FIRST');
    const step = verifyTotp(cipher.decrypt(req.user.totp_secret_enc), code);
    if (step === null) throw new HttpError(422, 'INVALID_CODE');
    await pool.query('UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE id = $1', [req.user.id, step]);
    await pool.query('UPDATE sessions SET mfa_passed = true WHERE id_hash = $1', [req.user.id_hash]);
    // Kill every other session for this user.
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [req.user.id, req.user.id_hash]);
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: req.user.restaurant_id, action: '2fa.enabled', ip: req.ip });
    return { ok: true };
  });

  // ---------- dashboard
  app.get('/api/admin/summary', { preHandler: auth('staff') }, async (req) => {
    const r = rid(req);
    const [today, open, rest] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS payments, coalesce(sum(share_minor),0)::bigint AS sales,
                coalesce(sum(tip_minor),0)::bigint AS tips, coalesce(sum(discount_minor),0)::bigint AS discounts
           FROM payments WHERE restaurant_id = $1 AND status = 'captured' AND captured_at >= date_trunc('day', now())`,
        [r],
      ),
      pool.query(`SELECT count(*)::int AS n FROM bills WHERE restaurant_id = $1 AND status = 'open'`, [r]),
      pool.query('SELECT name_en, name_ar, currency FROM restaurants WHERE id = $1', [r]),
    ]);
    return { restaurant: rest.rows[0], today: today.rows[0], open_bills: open.rows[0].n };
  });

  app.get('/api/admin/tables', { preHandler: auth('staff') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.label, t.active, b.id AS bill_id, b.total_minor,
              (SELECT coalesce(sum(share_minor),0) FROM payments p WHERE p.bill_id = b.id AND p.status = 'captured')::bigint AS paid_minor
         FROM dining_tables t LEFT JOIN bills b ON b.table_id = t.id AND b.status = 'open'
        WHERE t.restaurant_id = $1 ORDER BY t.label`,
      [rid(req)],
    );
    return { tables: rows };
  });

  app.post('/api/admin/tables', { preHandler: auth('manager') }, async (req, reply) => {
    const { label } = S.createTable.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO dining_tables(restaurant_id, label, public_token) VALUES ($1,$2,$3)
       ON CONFLICT (restaurant_id, label) DO NOTHING RETURNING id, label`,
      [rid(req), label, randomToken(18)],
    );
    if (!rows[0]) throw new HttpError(409, 'TABLE_EXISTS');
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'table.created', target: rows[0].id, ip: req.ip });
    reply.code(201);
    return rows[0];
  });

  // Rotating a token instantly invalidates the old printed QR (e.g. if a sticker was copied).
  app.post('/api/admin/tables/:id/rotate', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query(
      'UPDATE dining_tables SET public_token = $3 WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, rid(req), randomToken(18)],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'table.token_rotated', target: req.params.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/tables/:id/qr.svg', { preHandler: auth('staff') }, async (req, reply) => {
    const { rows } = await pool.query(
      'SELECT public_token FROM dining_tables WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, rid(req)],
    );
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND');
    const svg = await QRCode.toString(`${config.PUBLIC_BASE_URL}/t/${rows[0].public_token}`, {
      type: 'svg', margin: 2, errorCorrectionLevel: 'M',
    });
    reply.type('image/svg+xml').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return svg;
  });

  app.post('/api/admin/bills', { preHandler: auth('staff') }, async (req, reply) => {
    const body = S.createBill.parse(req.body);
    const bill = await openBill(pool, rid(req), body.table_id, body, { actorType: 'user', actorId: req.user.id, ip: req.ip });
    reply.code(201);
    return bill;
  });

  app.post('/api/admin/bills/:id/void', { preHandler: auth('manager') }, async (req) => {
    const r = await tx(pool, async (c) => {
      const b = await c.query('SELECT id FROM bills WHERE id = $1 AND restaurant_id = $2 AND status = $3 FOR UPDATE', [req.params.id, rid(req), 'open']);
      if (!b.rows[0]) throw new HttpError(404, 'NOT_FOUND');
      const paid = await c.query(
        `SELECT 1 FROM payments WHERE bill_id = $1 AND (status = 'captured' OR (status = 'pending' AND expires_at > now())) LIMIT 1`,
        [req.params.id],
      );
      if (paid.rowCount) throw new HttpError(409, 'BILL_HAS_PAYMENTS');
      await c.query(`UPDATE bills SET status = 'void', closed_at = now() WHERE id = $1`, [req.params.id]);
      await audit(c, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'bill.voided', target: req.params.id, ip: req.ip });
      return { ok: true };
    });
    return r;
  });

  app.get('/api/admin/payments', { preHandler: auth('staff') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT p.id, p.status, p.currency, p.share_minor, p.tip_minor, p.discount_minor, p.fee_minor, p.total_minor,
              p.card_brand, p.card_last4, p.flag, p.created_at, p.captured_at, t.label AS table_label
         FROM payments p JOIN bills b ON b.id = p.bill_id JOIN dining_tables t ON t.id = b.table_id
        WHERE p.restaurant_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [rid(req)],
    );
    return { payments: rows };
  });

  app.get('/api/admin/offers', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, kind, value, max_minor, min_spend_minor, title_en, title_ar, bank_name, promo_code,
              max_redemptions, redemptions, ends_at, active, (restaurant_id IS NULL) AS platform
         FROM offers WHERE restaurant_id = $1 OR restaurant_id IS NULL ORDER BY created_at DESC`,
      [rid(req)],
    );
    return { offers: rows };
  });

  app.post('/api/admin/offers', { preHandler: auth('manager') }, async (req, reply) => {
    const b = S.createPromo.parse(req.body);
    if (b.kind === 'percent' && b.value > 100) throw new HttpError(422, 'INVALID_PERCENT');
    const cur = (await pool.query('SELECT currency FROM restaurants WHERE id = $1', [rid(req)])).rows[0].currency;
    const { rows } = await pool.query(
      `INSERT INTO offers(restaurant_id, kind, value, max_minor, min_spend_minor, currency, title_en, title_ar,
                          promo_code, max_redemptions, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,upper($9),$10,$11)
       ON CONFLICT DO NOTHING RETURNING id`,
      [rid(req), b.kind, b.value, b.max_minor ?? null, b.min_spend_minor ?? null, cur, b.title_en, b.title_ar,
        b.promo_code, b.max_redemptions ?? null, b.ends_at ?? null],
    );
    if (!rows[0]) throw new HttpError(409, 'CODE_EXISTS');
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'offer.created', target: rows[0].id, ip: req.ip });
    reply.code(201);
    return rows[0];
  });

  // POS credentials: generated server-side, shown ONCE, stored hashed/encrypted.
  app.post('/api/admin/pos-credentials', { preHandler: auth('owner') }, async (req) => {
    const key = `pk_${randomToken(24)}`;
    const secret = `ps_${randomToken(32)}`;
    await pool.query('UPDATE restaurants SET pos_key_hash = $2, pos_secret_enc = $3 WHERE id = $1', [
      rid(req), sha256(key), cipher.encrypt(secret),
    ]);
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.credentials_rotated', ip: req.ip });
    return { pos_key: key, pos_secret: secret, note: 'Store these now. The secret cannot be shown again.' };
  });

  app.get('/api/admin/audit', { preHandler: auth('owner') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT at, actor_type, actor_id, action, target, ip, meta FROM audit_log
        WHERE restaurant_id = $1 ORDER BY id DESC LIMIT 200`,
      [rid(req)],
    );
    return { events: rows };
  });
}

/** Opens a bill for a table (shared by admin UI and POS API). Total is computed from items on the server. */
export async function openBill(pool, restaurantId, tableId, body, actor) {
  return tx(pool, async (c) => {
    const t = await c.query(
      `SELECT t.id, r.currency FROM dining_tables t JOIN restaurants r ON r.id = t.restaurant_id
        WHERE t.id = $1 AND t.restaurant_id = $2 AND t.active`,
      [tableId, restaurantId],
    );
    if (!t.rows[0]) throw new HttpError(404, 'TABLE_NOT_FOUND');
    const total = body.items.reduce((s, i) => s + i.unit_price_minor * i.qty, 0);
    if (total <= 0 || total > 100_000_000) throw new HttpError(422, 'INVALID_TOTAL');
    if (body.vat_minor > total) throw new HttpError(422, 'INVALID_VAT');
    let bill;
    try {
      ({ rows: [bill] } = await c.query(
        `INSERT INTO bills(restaurant_id, table_id, external_ref, currency, total_minor, vat_minor)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, total_minor, currency`,
        [restaurantId, tableId, body.external_ref ?? null, t.rows[0].currency, total, body.vat_minor],
      ));
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'TABLE_HAS_OPEN_BILL');
      throw e;
    }
    let pos = 0;
    for (const i of body.items) {
      await c.query(
        'INSERT INTO bill_items(bill_id, name_en, name_ar, unit_price_minor, qty, position) VALUES ($1,$2,$3,$4,$5,$6)',
        [bill.id, i.name_en, i.name_ar, i.unit_price_minor, i.qty, pos++],
      );
    }
    await audit(c, { ...actor, restaurantId, action: 'bill.opened', target: bill.id, meta: { total_minor: total } });
    return bill;
  });
}
