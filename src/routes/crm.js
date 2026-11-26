import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { maskPhone } from '../lib/phone.js';
import { HttpError } from '../services/bills.js';
import { customerStats, issueCampaign, notifyCoupon } from '../services/campaigns.js';

const campaignBody = z.strictObject({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['fixed', 'percent', 'free_item']),
  value: z.number().int().min(1).max(100_000_000),
  item_name: z.string().trim().min(1).max(120).optional(),
  max_minor: z.number().int().min(1).max(100_000_000).optional(),
  min_spend_minor: z.number().int().min(1).max(100_000_000).optional(),
  audience: z.enum(['all', 'frequent', 'lapsed', 'birthday']),
  audience_param: z.number().int().min(1).max(365).optional(),
  valid_days: z.number().int().min(1).max(365).default(14),
}).refine((b) => b.kind !== 'percent' || b.value <= 100, 'percent <= 100')
  .refine((b) => b.kind !== 'free_item' || b.item_name, 'item_name required');

const settingsBody = z.strictObject({
  google_review_url: z.url().max(500).refine((u) => u.startsWith('https://'), 'https only').nullable().optional(),
  require_phone: z.boolean().optional(),
  loyalty_enabled: z.boolean().optional(),
  points_per_unit: z.number().int().min(0).max(1000).optional(),
  vat_bps: z.number().int().min(0).max(3000).optional(),
});

/** Restaurant-side CRM. Registered inside the admin plugin (session + CSRF hooks apply). */
export default async function crmRoutes(app, { ctx, auth, rid }) {
  const { pool } = ctx;

  app.get('/api/admin/customers', { preHandler: auth('manager') }, async (req) => {
    const s = await customerStats(pool, rid(req));
    // Restaurants see diners' names and visit history, never their full phone number.
    s.top = s.top.map(({ phone_e164, ...c }) => ({ ...c, phone: maskPhone(phone_e164) }));
    return s;
  });

  app.post('/api/admin/customers/:id/points', { preHandler: auth('manager') }, async (req) => {
    const b = z.strictObject({ points: z.number().int().min(-100000).max(100000).refine((n) => n !== 0), reason: z.string().trim().min(2).max(120) }).parse(req.body);
    const visited = await pool.query(
      `SELECT 1 FROM payments WHERE restaurant_id = $1 AND customer_id = $2 AND status = 'captured' LIMIT 1`, [rid(req), req.params.id],
    );
    if (!visited.rowCount) throw new HttpError(404, 'NOT_FOUND');
    await pool.query(
      `INSERT INTO loyalty_ledger(restaurant_id, customer_id, points, reason, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [rid(req), req.params.id, b.points, b.reason, req.user.id],
    );
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'loyalty.adjusted', target: req.params.id, ip: req.ip, meta: { points: b.points } });
    return { ok: true };
  });

  app.get('/api/admin/campaigns', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT count(*) FROM coupons k WHERE k.campaign_id = c.id)::int AS issued,
              (SELECT count(*) FROM coupons k WHERE k.campaign_id = c.id AND k.status = 'redeemed')::int AS redeemed
         FROM campaigns c WHERE c.restaurant_id = $1 ORDER BY c.created_at DESC`, [rid(req)],
    );
    return { campaigns: rows };
  });

  app.post('/api/admin/campaigns', { preHandler: auth('manager'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = campaignBody.parse(req.body);
    const { rows: [c] } = await pool.query(
      `INSERT INTO campaigns(restaurant_id, name, kind, value, item_name, max_minor, min_spend_minor, audience, audience_param, valid_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [rid(req), b.name, b.kind, b.value, b.item_name ?? null, b.max_minor ?? null, b.min_spend_minor ?? null,
        b.audience, b.audience_param ?? null, b.valid_days, req.user.id],
    );
    const ids = await issueCampaign(pool, c);
    const { rows: [rest] } = await pool.query('SELECT name_en, name_ar FROM restaurants WHERE id = $1', [rid(req)]);
    notifyCoupon(ctx, rest, c, ids).catch((e) => req.log.warn(e));
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'campaign.created', target: c.id, ip: req.ip, meta: { audience: b.audience, issued: ids.length } });
    reply.code(201);
    return { campaign: c, issued: ids.length };
  });

  app.post('/api/admin/campaigns/:id/toggle', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query('UPDATE campaigns SET active = NOT active WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  app.get('/api/admin/ratings', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT g.stars, g.comment, g.created_at, c.name, t.label AS table_label
         FROM ratings g LEFT JOIN customers c ON c.id = g.customer_id
         JOIN payments p ON p.id = g.payment_id JOIN bills b ON b.id = p.bill_id JOIN dining_tables t ON t.id = b.table_id
        WHERE g.restaurant_id = $1 ORDER BY g.created_at DESC LIMIT 100`, [rid(req)],
    );
    return { ratings: rows };
  });

  app.get('/api/admin/settings', { preHandler: auth('manager') }, async (req) => {
    const { rows: [r] } = await pool.query(
      'SELECT google_review_url, require_phone, loyalty_enabled, points_per_unit, currency, vat_bps FROM restaurants WHERE id = $1', [rid(req)],
    );
    return r;
  });

  app.put('/api/admin/settings', { preHandler: auth('owner') }, async (req) => {
    const b = settingsBody.parse(req.body);
    await pool.query(
      `UPDATE restaurants SET google_review_url = CASE WHEN $2 THEN $3 ELSE google_review_url END,
              require_phone = coalesce($4, require_phone), loyalty_enabled = coalesce($5, loyalty_enabled),
              points_per_unit = coalesce($6, points_per_unit), vat_bps = coalesce($7, vat_bps)
        WHERE id = $1`,
      [rid(req), 'google_review_url' in b, b.google_review_url ?? null, b.require_phone ?? null, b.loyalty_enabled ?? null, b.points_per_unit ?? null, b.vat_bps ?? null],
    );
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'settings.updated', ip: req.ip, meta: Object.keys(b) });
    return { ok: true };
  });
}
