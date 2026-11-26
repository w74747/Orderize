import { z } from 'zod';
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { HttpError } from '../services/bills.js';

const cur = z.enum(['AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR']);
const minor = z.number().int().min(0).max(1_000_000_000);
const text = (n) => z.string().trim().min(1).max(n);

const restaurantBody = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  name_en: text(80), name_ar: text(80),
  country: z.enum(['AE', 'SA', 'QA', 'KW', 'BH', 'OM']),
  currency: cur,
  owner_email: z.email().max(200),
  plan_id: z.uuid().optional(),
  trial_days: z.number().int().min(0).max(90).default(14),
});
const subscriptionBody = z.strictObject({
  plan_id: z.uuid().nullable().optional(),
  status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']),
  current_period_end: z.iso.date().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
const planBody = z.strictObject({
  name: text(60), price_minor: minor, currency: cur, interval: z.enum(['month', 'year']),
  features: z.array(text(80)).max(20).default([]),
});
const invoiceBody = z.strictObject({
  amount_minor: minor, period_start: z.iso.date(), period_end: z.iso.date(),
  status: z.enum(['due', 'paid']).default('due'), reference: z.string().max(100).optional(),
});
const bankOfferBody = z.strictObject({
  restaurant_id: z.uuid().nullable().optional(),     // null = every restaurant in that currency
  bank_name: text(60), title_en: text(80), title_ar: text(80),
  kind: z.enum(['percent', 'fixed']), value: z.number().int().min(1).max(100_000_000),
  currency: cur, max_minor: minor.optional(), min_spend_minor: minor.optional(),
  bin_prefixes: z.array(z.string().regex(/^\d{6,8}$/)).min(1).max(200),
  theme: z.enum(['dark', 'blue', 'green', 'purple']).default('dark'),
  max_redemptions: z.number().int().min(1).max(10_000_000).optional(),
  starts_at: z.iso.datetime().optional(), ends_at: z.iso.datetime().optional(),
}).refine((b) => b.kind !== 'percent' || b.value <= 100, 'percent <= 100');

/** Platform console API. Registered inside the admin plugin (session + CSRF hooks apply). */
export default async function platformRoutes(app, { ctx, auth }) {
  const { pool, config } = ctx;
  const base = auth('platform_admin', { allowNoMfa: true });
  // The platform account controls every restaurant: 2FA is always mandatory for it.
  const guard = async (req, reply) => {
    await base(req, reply);
    if (config.PLATFORM_REQUIRE_2FA && !(req.user.totp_enabled && req.user.mfa_passed)) throw new HttpError(403, 'MFA_SETUP_REQUIRED');
  };
  const log = (req, action, target, meta) => audit(pool, { actorType: 'user', actorId: req.user.id, action, target, ip: req.ip, meta });

  app.get('/api/platform/overview', { preHandler: guard }, async () => {
    const { rows: [o] } = await pool.query(
      `SELECT (SELECT count(*) FROM restaurants)::int AS restaurants,
              (SELECT count(*) FROM restaurants WHERE active)::int AS active_restaurants,
              (SELECT count(*) FROM subscriptions WHERE status = 'past_due')::int AS past_due,
              (SELECT count(*) FROM customers WHERE deleted_at IS NULL)::int AS customers,
              (SELECT count(*) FROM payments WHERE status = 'captured' AND captured_at > now() - interval '30 days')::int AS payments_30d,
              (SELECT count(*) FROM subscription_invoices WHERE status = 'due')::int AS invoices_due`,
    );
    const { rows: gmv } = await pool.query(
      `SELECT currency, sum(share_minor)::bigint AS gmv_minor, sum(fee_minor)::bigint AS fees_minor
         FROM payments WHERE status = 'captured' AND captured_at > now() - interval '30 days' GROUP BY currency`,
    );
    return { ...o, gmv_30d: gmv };
  });

  app.get('/api/platform/restaurants', { preHandler: guard }, async () => {
    const { rows } = await pool.query(
      `SELECT r.id, r.slug, r.name_en, r.name_ar, r.country, r.currency, r.active, r.created_at,
              s.status AS sub_status, s.current_period_end, s.notes, s.plan_id, p.name AS plan_name,
              (SELECT coalesce(sum(share_minor),0) FROM payments x WHERE x.restaurant_id = r.id AND x.status = 'captured'
                 AND x.captured_at > now() - interval '30 days')::bigint AS gmv_30d,
              (SELECT pc.provider FROM pos_connections pc WHERE pc.restaurant_id = r.id) AS pos,
              (SELECT email FROM users u WHERE u.restaurant_id = r.id AND u.role = 'owner' ORDER BY created_at LIMIT 1) AS owner_email
         FROM restaurants r LEFT JOIN subscriptions s ON s.restaurant_id = r.id LEFT JOIN plans p ON p.id = s.plan_id
        ORDER BY r.created_at DESC`,
    );
    return { restaurants: rows };
  });

  app.post('/api/platform/restaurants', { preHandler: guard }, async (req, reply) => {
    const b = restaurantBody.parse(req.body);
    const tempPassword = `${randomToken(10)}-${randomToken(4)}`;
    const hash = await hashPassword(tempPassword);
    const r = await tx(pool, async (db) => {
      const { rows: [r] } = await db.query(
        `INSERT INTO restaurants(slug, name_en, name_ar, country, currency) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (slug) DO NOTHING RETURNING id`, [b.slug, b.name_en, b.name_ar, b.country, b.currency],
      );
      if (!r) throw new HttpError(409, 'SLUG_TAKEN');
      try {
        await db.query(`INSERT INTO users(restaurant_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')`, [r.id, b.owner_email, hash]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'EMAIL_TAKEN');
        throw e;
      }
      await db.query(
        `INSERT INTO subscriptions(restaurant_id, plan_id, status, current_period_end)
         VALUES ($1,$2,'trial', current_date + make_interval(days => $3))`, [r.id, b.plan_id ?? null, b.trial_days],
      );
      return r;
    });
    await log(req, 'platform.restaurant_created', r.id, { slug: b.slug });
    reply.code(201);
    // Shown once. The owner must change it after first sign-in (and set up 2FA).
    return { id: r.id, owner_email: b.owner_email, temporary_password: tempPassword };
  });

  app.put('/api/platform/restaurants/:id/subscription', { preHandler: guard }, async (req) => {
    const b = subscriptionBody.parse(req.body);
    const active = !['suspended', 'cancelled'].includes(b.status);
    await tx(pool, async (db) => {
      const { rowCount } = await db.query('UPDATE restaurants SET active = $2 WHERE id = $1', [req.params.id, active]);
      if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
      await db.query(
        `INSERT INTO subscriptions(restaurant_id, plan_id, status, current_period_end, notes, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (restaurant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end, notes = EXCLUDED.notes, updated_at = now()`,
        [req.params.id, b.plan_id ?? null, b.status, b.current_period_end ?? null, b.notes ?? null],
      );
      if (!active) await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE restaurant_id = $1)', [req.params.id]);
    });
    await log(req, 'platform.subscription_updated', req.params.id, { status: b.status });
    return { ok: true, active };
  });

  app.get('/api/platform/restaurants/:id/invoices', { preHandler: guard }, async (req) => {
    const { rows } = await pool.query('SELECT * FROM subscription_invoices WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    return { invoices: rows };
  });

  app.post('/api/platform/restaurants/:id/invoices', { preHandler: guard }, async (req, reply) => {
    const b = invoiceBody.parse(req.body);
    if (b.period_end < b.period_start) throw new HttpError(422, 'INVALID_PERIOD');
    const { rows: [r] } = await pool.query('SELECT currency FROM restaurants WHERE id = $1', [req.params.id]);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    const { rows: [inv] } = await pool.query(
      `INSERT INTO subscription_invoices(restaurant_id, amount_minor, currency, period_start, period_end, status, reference, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'paid' THEN now() END) RETURNING *`,
      [req.params.id, b.amount_minor, r.currency, b.period_start, b.period_end, b.status, b.reference ?? null],
    );
    await log(req, 'platform.invoice_created', inv.id, { amount_minor: b.amount_minor });
    reply.code(201);
    return inv;
  });

  app.post('/api/platform/invoices/:id/paid', { preHandler: guard }, async (req) => {
    const ref = z.string().max(100).optional().parse(req.body?.reference);
    const { rows: [inv] } = await pool.query(
      `UPDATE subscription_invoices SET status = 'paid', paid_at = now(), reference = coalesce($2, reference)
        WHERE id = $1 AND status = 'due' RETURNING restaurant_id, period_end`, [req.params.id, ref ?? null],
    );
    if (!inv) throw new HttpError(404, 'NOT_FOUND');
    // Paying an invoice extends the subscription and re-activates a past-due restaurant.
    await pool.query(
      `UPDATE subscriptions SET status = 'active', current_period_end = greatest(coalesce(current_period_end, $2), $2), updated_at = now()
        WHERE restaurant_id = $1 AND status IN ('trial','active','past_due')`, [inv.restaurant_id, inv.period_end],
    );
    await log(req, 'platform.invoice_paid', req.params.id);
    return { ok: true };
  });

  // ---- TEST-ONLY WhatsApp link by QR (personal number)
  const wa = () => {
    if (!ctx.waweb) throw new HttpError(404, 'WHATSAPP_WEB_DISABLED');
    return ctx.waweb;
  };
  app.get('/api/platform/whatsapp', { preHandler: guard }, async () => ({
    enabled: Boolean(ctx.waweb), official: Boolean(config.WHATSAPP_TOKEN),
    ...(ctx.waweb ? await ctx.waweb.status() : {}),
  }));
  app.post('/api/platform/whatsapp/connect', { preHandler: guard }, async (req) => {
    await wa().start();
    await log(req, 'platform.whatsapp_web_connect');
    return { ok: true };
  });
  app.post('/api/platform/whatsapp/disconnect', { preHandler: guard }, async (req) => {
    await wa().logout();
    await log(req, 'platform.whatsapp_web_unlinked');
    return { ok: true };
  });
  app.post('/api/platform/whatsapp/test', { preHandler: guard, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const { normalizePhone } = await import('../lib/phone.js');
    const b = z.strictObject({ country: z.string().max(5), phone: z.string().max(20) }).parse(req.body);
    const e164 = normalizePhone(b.country, b.phone);
    if (!e164) throw new HttpError(422, 'INVALID_PHONE');
    try {
      await wa().sendText(e164, 'Orderize: test message ✅ — WhatsApp sign-in codes will be sent from this number.');
    } catch (e) {
      throw new HttpError(502, e.message === 'send limit' ? 'SEND_LIMIT' : 'WHATSAPP_NOT_CONNECTED');
    }
    await log(req, 'platform.whatsapp_web_test');
    return { ok: true };
  });

  app.get('/api/platform/plans', { preHandler: guard }, async () => ({ plans: (await pool.query('SELECT * FROM plans ORDER BY created_at')).rows }));

  app.post('/api/platform/plans', { preHandler: guard }, async (req, reply) => {
    const b = planBody.parse(req.body);
    const { rows: [p] } = await pool.query(
      'INSERT INTO plans(name, price_minor, currency, interval, features) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [b.name, b.price_minor, b.currency, b.interval, JSON.stringify(b.features)],
    );
    await log(req, 'platform.plan_created', p.id);
    reply.code(201);
    return p;
  });

  app.get('/api/platform/bank-offers', { preHandler: guard }, async () => {
    const { rows } = await pool.query(
      `SELECT o.*, r.name_en AS restaurant_name FROM offers o LEFT JOIN restaurants r ON r.id = o.restaurant_id
        WHERE o.bin_prefixes IS NOT NULL ORDER BY o.created_at DESC`,
    );
    return { offers: rows };
  });

  app.post('/api/platform/bank-offers', { preHandler: guard }, async (req, reply) => {
    const b = bankOfferBody.parse(req.body);
    const { rows: [o] } = await pool.query(
      `INSERT INTO offers(restaurant_id, kind, value, max_minor, min_spend_minor, currency, title_en, title_ar, bank_name, theme,
                          bin_prefixes, max_redemptions, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [b.restaurant_id ?? null, b.kind, b.value, b.max_minor ?? null, b.min_spend_minor ?? null, b.currency, b.title_en, b.title_ar,
        b.bank_name, b.theme, b.bin_prefixes, b.max_redemptions ?? null, b.starts_at ?? null, b.ends_at ?? null],
    );
    await log(req, 'platform.bank_offer_created', o.id, { bank: b.bank_name });
    reply.code(201);
    return o;
  });

  app.post('/api/platform/bank-offers/:id/toggle', { preHandler: guard }, async (req) => {
    const { rowCount } = await pool.query('UPDATE offers SET active = NOT active WHERE id = $1 AND bin_prefixes IS NOT NULL', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    await log(req, 'platform.bank_offer_toggled', req.params.id);
    return { ok: true };
  });
}

/** Creates the first platform admin from env at boot (only if none exists). */
export async function bootstrapPlatformAdmin(pool, config, log) {
  if (!config.PLATFORM_ADMIN_EMAIL || !config.PLATFORM_ADMIN_PASSWORD) return;
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE role = 'platform_admin' LIMIT 1`);
  if (rows.length) return;
  await pool.query(
    `INSERT INTO users(email, password_hash, role) VALUES ($1,$2,'platform_admin') ON CONFLICT DO NOTHING`,
    [config.PLATFORM_ADMIN_EMAIL, await hashPassword(config.PLATFORM_ADMIN_PASSWORD)],
  );
  log.info('platform admin created');
}
