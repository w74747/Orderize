import QRCode from 'qrcode';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { HttpError, findTable } from '../services/bills.js';
import { sessionUser, ROLE_RANK } from '../services/auth.js';
import { board, callWaiter, placeOrder, resolveCall, setOrderStatus, tableOrders } from '../services/orders.js';
import { getDiner } from './me.js';

const orderBody = z.strictObject({
  client_key: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  note: z.string().trim().max(300).optional(),
  items: z.array(z.strictObject({
    item_id: z.uuid(),
    qty: z.number().int().min(1).max(20),
    options: z.array(z.uuid()).max(60).default([]),
    note: z.string().trim().max(140).optional(),
  })).min(1).max(30),
});
const statusBody = z.strictObject({
  status: z.enum(['preparing', 'ready', 'served', 'cancelled']),
  reason: z.string().trim().max(200).optional(),
});

const stationCookie = (config) => (config.COOKIE_SECURE ? '__Host-orderize_station' : 'orderize_station');
const adminCookie = (config) => (config.COOKIE_SECURE ? '__Host-orderize_sid' : 'orderize_sid');

/** Same-origin JSON only for state changes (CSRF defence on top of SameSite cookies). */
function csrfHook(origin) {
  return async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers.origin !== origin) throw new HttpError(403, 'BAD_ORIGIN');
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON_ONLY');
  };
}

/** Diner side: place orders, follow them, call the waiter, banner analytics. */
export async function tableOrderRoutes(app, { ctx }) {
  const { pool, config } = ctx;
  app.addHook('onRequest', csrfHook(new URL(config.PUBLIC_BASE_URL).origin));
  app.addHook('onSend', async (req, reply) => { reply.header('cache-control', 'no-store'); });

  app.post('/api/t/:token/orders', { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = orderBody.parse(req.body);
    const o = await placeOrder(ctx, { token: req.params.token, body, customer: await getDiner(ctx, req), ip: req.ip });
    reply.code(201);
    return o;
  });

  app.get('/api/t/:token/orders', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => tableOrders(pool, req.params.token));

  app.post('/api/t/:token/call', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req) => {
    const kind = z.strictObject({ kind: z.enum(['waiter', 'bill']) }).parse(req.body).kind;
    return callWaiter(pool, req.params.token, kind, req.ip);
  });

  app.post('/api/t/:token/banners/:id/click', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const r = await findTable(pool, req.params.token);
    if (!r || !/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND');
    await pool.query('UPDATE menu_banners SET clicks = clicks + 1 WHERE id = $1 AND restaurant_id = $2', [req.params.id, r.id]);
    return { ok: true };
  });

  app.post('/api/t/:token/banners/seen', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const ids = z.strictObject({ ids: z.array(z.uuid()).max(12) }).parse(req.body).ids;
    const r = await findTable(pool, req.params.token);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    if (ids.length) await pool.query('UPDATE menu_banners SET views = views + 1 WHERE restaurant_id = $1 AND id = ANY($2::uuid[])', [r.id, ids]);
    return { ok: true };
  });
}

/**
 * Staff side, used by the dashboard (admin session) and by paired order-station devices
 * (device cookie). A device can only see and move orders; it never sees settings or money reports.
 */
export async function stationRoutes(app, { ctx }) {
  const { pool, config } = ctx;
  const DEV = stationCookie(config);
  const cookieOpts = { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict' };
  app.addHook('onRequest', csrfHook(new URL(config.PUBLIC_BASE_URL).origin));
  app.addHook('onSend', async (req, reply) => { reply.header('cache-control', 'no-store'); });

  async function actor(req) {
    const tok = req.cookies[DEV];
    if (tok && /^[A-Za-z0-9_-]{40,64}$/.test(tok)) {
      const { rows: [d] } = await pool.query(
        `UPDATE order_devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL
          RETURNING id, restaurant_id, name`, [sha256(tok)],
      );
      if (d) return { restaurantId: d.restaurant_id, label: `device:${d.name}`, actorType: 'device', actorId: d.id, ip: req.ip, device: d.name };
    }
    const u = await sessionUser(pool, req.cookies[adminCookie(config)]);
    if (u && u.restaurant_id && ROLE_RANK[u.role] >= ROLE_RANK.staff
      && !(config.REQUIRE_2FA && !(u.totp_enabled && u.mfa_passed))) {
      return { restaurantId: u.restaurant_id, label: `user:${u.email}`, actorType: 'user', actorId: u.id, ip: req.ip, user: u.email };
    }
    throw new HttpError(401, 'UNAUTHENTICATED');
  }

  app.post('/api/station/pair', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const code = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) }).parse(req.body).code;
    const token = randomToken(32);
    const { rows: [d] } = await pool.query(
      `UPDATE order_devices SET token_hash = $2, pair_code_hash = NULL, pair_expires_at = NULL, paired_at = now(), last_seen_at = now()
        WHERE pair_code_hash = $1 AND pair_expires_at > now() AND revoked_at IS NULL
        RETURNING id, restaurant_id, name`, [sha256(code), sha256(token)],
    );
    if (!d) throw new HttpError(400, 'PAIR_CODE_INVALID');
    await audit(pool, { actorType: 'device', actorId: d.id, restaurantId: d.restaurant_id, action: 'device.paired', ip: req.ip });
    reply.setCookie(DEV, token, { ...cookieOpts, maxAge: 365 * 86400 });
    return { ok: true, name: d.name };
  });

  app.post('/api/station/unpair', async (req, reply) => {
    const tok = req.cookies[DEV];
    if (tok) await pool.query('UPDATE order_devices SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(tok)]);
    reply.clearCookie(DEV, cookieOpts);
    return { ok: true };
  });

  app.get('/api/orders/whoami', async (req) => {
    const a = await actor(req);
    const { rows: [r] } = await pool.query('SELECT name_en, name_ar, currency FROM restaurants WHERE id = $1', [a.restaurantId]);
    return { device: a.device ?? null, user: a.user ?? null, restaurant: r };
  });

  app.get('/api/orders/board', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => board(pool, (await actor(req)).restaurantId));

  app.post('/api/orders/:id/status', async (req) => {
    const a = await actor(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND');
    return setOrderStatus(pool, a, req.params.id, statusBody.parse(req.body));
  });

  app.post('/api/orders/calls/:id/resolve', async (req) => {
    const a = await actor(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND');
    return resolveCall(pool, a.restaurantId, req.params.id);
  });
}

/** Device management inside the restaurant dashboard (admin plugin: session + CSRF hooks apply). */
export async function deviceAdminRoutes(app, { ctx, auth, rid }) {
  const { pool, config } = ctx;
  const PAIR_MINUTES = 10;

  async function pairCode(req, id) {
    const code = randomToken(18);
    const { rowCount } = await pool.query(
      `UPDATE order_devices SET pair_code_hash = $3, pair_expires_at = now() + make_interval(mins => $4)
        WHERE id = $1 AND restaurant_id = $2 AND revoked_at IS NULL`, [id, rid(req), sha256(code), PAIR_MINUTES],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    // The code travels in the URL fragment, so it never reaches server or proxy logs.
    const url = `${config.PUBLIC_BASE_URL}/station#pair=${code}`;
    return { pair_url: url, qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1 }), expires_in_minutes: PAIR_MINUTES };
  }

  app.get('/api/admin/devices', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, name, paired_at, last_seen_at, created_at, (pair_expires_at > now()) AS pairing
         FROM order_devices WHERE restaurant_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [rid(req)],
    );
    return { devices: rows };
  });

  app.post('/api/admin/devices', { preHandler: auth('manager'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const name = z.strictObject({ name: z.string().trim().min(1).max(60) }).parse(req.body).name;
    const n = (await pool.query('SELECT count(*)::int AS n FROM order_devices WHERE restaurant_id = $1 AND revoked_at IS NULL', [rid(req)])).rows[0].n;
    if (n >= 20) throw new HttpError(422, 'TOO_MANY_DEVICES');
    const { rows: [d] } = await pool.query(
      'INSERT INTO order_devices(restaurant_id, name, created_by) VALUES ($1,$2,$3) RETURNING id, name', [rid(req), name, req.user.id],
    );
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'device.created', target: d.id, ip: req.ip });
    reply.code(201);
    return { ...d, ...(await pairCode(req, d.id)) };
  });

  app.post('/api/admin/devices/:id/pair-code', { preHandler: auth('manager') }, async (req) => pairCode(req, req.params.id));

  app.delete('/api/admin/devices/:id', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query(
      'UPDATE order_devices SET revoked_at = now(), token_hash = NULL, pair_code_hash = NULL WHERE id = $1 AND restaurant_id = $2 AND revoked_at IS NULL',
      [req.params.id, rid(req)],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'device.revoked', target: req.params.id, ip: req.ip });
    return { ok: true };
  });
}
