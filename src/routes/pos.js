// POS integration API. Every request is signed:
//   X-Pos-Key:        pk_...            (identifies the restaurant)
//   X-Pos-Timestamp:  unix seconds      (must be within ±300s)
//   X-Pos-Nonce:      16-64 random chars (single use)
//   X-Pos-Signature:  hex HMAC-SHA256(secret, `${timestamp}.${nonce}.${METHOD}.${path}.${rawBody}`)
// Paid events are PULLED by the POS (GET /api/pos/v1/events) — we never call out to
// arbitrary restaurant URLs, which removes a whole class of SSRF risk.
import { hmacHex, safeEqual, sha256 } from '../lib/crypto.js';
import { HttpError } from '../services/bills.js';
import { openBill } from './admin.js';
import { posBill } from './schemas.js';

export default async function posRoutes(app, { ctx }) {
  const { pool, cipher } = ctx;

  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 128 * 1024 }, (req, body, done) =>
    done(null, body),
  );

  app.addHook('preHandler', async (req) => {
    const key = req.headers['x-pos-key'];
    const ts = Number(req.headers['x-pos-timestamp']);
    const nonce = req.headers['x-pos-nonce'];
    const sig = req.headers['x-pos-signature'];
    if (typeof key !== 'string' || !key.startsWith('pk_') || typeof sig !== 'string') throw new HttpError(401, 'UNAUTHORIZED');
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) throw new HttpError(401, 'STALE_REQUEST');
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(401, 'UNAUTHORIZED');

    const { rows } = await pool.query('SELECT id, pos_secret_enc FROM restaurants WHERE pos_key_hash = $1 AND active', [sha256(key)]);
    if (!rows[0]) throw new HttpError(401, 'UNAUTHORIZED');
    const secret = cipher.decrypt(rows[0].pos_secret_enc);
    const raw = typeof req.body === 'string' ? req.body : '';
    const expected = hmacHex(secret, `${ts}.${nonce}.${req.method}.${req.url}.${raw}`);
    if (!safeEqual(expected, sig)) throw new HttpError(401, 'UNAUTHORIZED');

    const n = await pool.query(
      'INSERT INTO pos_nonces(restaurant_id, nonce) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1',
      [rows[0].id, nonce],
    );
    if (!n.rowCount) throw new HttpError(401, 'REPLAYED_REQUEST');
    req.restaurantId = rows[0].id;
    req.json = raw ? JSON.parse(raw) : null;
  });

  app.post('/api/pos/v1/bills', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = posBill.parse(req.json);
    const t = await pool.query('SELECT id FROM dining_tables WHERE restaurant_id = $1 AND label = $2', [req.restaurantId, body.table_label]);
    if (!t.rows[0]) throw new HttpError(404, 'TABLE_NOT_FOUND');
    const bill = await openBill(pool, req.restaurantId, t.rows[0].id, body, { actorType: 'pos', ip: req.ip });
    reply.code(201);
    return bill;
  });

  app.get('/api/pos/v1/events', async (req) => {
    const after = Math.max(0, Number.parseInt(req.query.after ?? '0', 10) || 0);
    const { rows } = await pool.query(
      'SELECT id, type, payload, created_at FROM outbox WHERE restaurant_id = $1 AND id > $2 ORDER BY id LIMIT 100',
      [req.restaurantId, after],
    );
    return { events: rows };
  });
}
