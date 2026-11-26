import crypto from 'node:crypto';
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { BillingError, CURRENCIES, quote, remainingOf } from '../../shared/billing.js';
import { syncTableBill } from '../pos/service.js';

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const LIVE = `(p.status = 'captured' OR (p.status = 'pending' AND p.expires_at > now()))`;

export function policyOf(r) {
  return {
    tip_percents: r.tip_percents,
    default_tip_percent: r.default_tip_percent,
    max_tip_percent: r.max_tip_percent,
    fee_bps: r.fee_bps,
    fee_fixed_minor: r.fee_fixed_minor,
    fee_cap_minor: r.fee_cap_minor,
  };
}

export async function findTable(db, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(token)) return null;
  const { rows } = await db.query(
    `SELECT t.id AS table_id, t.label, t.external_id, t.external_name, r.*
       FROM dining_tables t JOIN restaurants r ON r.id = t.restaurant_id
      WHERE t.public_token = $1 AND t.active AND r.active`,
    [token],
  );
  return rows[0] ?? null;
}

/** Loads the open bill for a table with settlement state. Pass a tx client + lock=true to lock it. */
export async function loadOpenBill(db, tableId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM bills WHERE table_id = $1 AND status = 'open' ${lock ? 'FOR UPDATE' : ''}`,
    [tableId],
  );
  const bill = rows[0];
  if (!bill) return null;
  return hydrate(db, bill);
}

async function hydrate(db, bill) {
  const [items, settled, settledItems, paidCount] = await Promise.all([
    db.query('SELECT id, name_en, name_ar, unit_price_minor, qty FROM bill_items WHERE bill_id = $1 ORDER BY position, id', [bill.id]),
    db.query(`SELECT coalesce(sum(share_minor),0)::bigint AS s FROM payments p WHERE bill_id = $1 AND ${LIVE}`, [bill.id]),
    db.query(
      `SELECT e->>'id' AS id, sum((e->>'qty')::int)::int AS q
         FROM payments p, jsonb_array_elements(p.items) e
        WHERE p.bill_id = $1 AND p.items IS NOT NULL AND ${LIVE}
        GROUP BY 1`,
      [bill.id],
    ),
    db.query(`SELECT count(*)::int AS n FROM payments WHERE bill_id = $1 AND status = 'captured'`, [bill.id]),
  ]);
  const sq = new Map(settledItems.rows.map((r) => [r.id, r.q]));
  return {
    ...bill,
    // Paid in Orderize (captured or being paid now) + paid directly at the POS (cash, card machine).
    settled_minor: settled.rows[0].s + (bill.external_paid_minor ?? 0),
    payments_count: paidCount.rows[0].n,
    items: items.rows.map((i) => ({ ...i, settled_qty: sq.get(i.id) ?? 0 })),
  };
}

export async function activeBankOffers(db, restaurant) {
  const { rows } = await db.query(
    `SELECT id, kind, value, max_minor, min_spend_minor, currency, title_en, title_ar, bank_name, theme
       FROM offers
      WHERE active AND bin_prefixes IS NOT NULL
        AND (restaurant_id IS NULL OR restaurant_id = $1)
        AND (currency IS NULL OR currency = $2)
        AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        AND (max_redemptions IS NULL OR redemptions < max_redemptions)
      ORDER BY created_at`,
    [restaurant.id, restaurant.currency],
  );
  return rows;
}

/** One discount per payment: bank offer, promo code, or the diner's own coupon. */
async function resolveDiscount(db, restaurant, body, { customer, bill, lock = false } = {}) {
  const { offer_id, promo_code, coupon_id } = body;
  if ([offer_id, promo_code, coupon_id].filter(Boolean).length > 1) throw new HttpError(400, 'ONE_OFFER_ONLY');
  if (coupon_id) return resolveCoupon(db, restaurant, coupon_id, { customer, bill, lock });
  if (!offer_id && !promo_code) return null;
  const { rows } = await db.query(
    `SELECT * FROM offers
      WHERE active
        AND ${offer_id ? 'id = $3 AND bin_prefixes IS NOT NULL' : 'promo_code = upper($3)'}
        AND (restaurant_id IS NULL OR restaurant_id = $1)
        AND (currency IS NULL OR currency = $2)
        AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        AND (max_redemptions IS NULL OR redemptions < max_redemptions)`,
    [restaurant.id, restaurant.currency, offer_id ?? promo_code],
  );
  if (!rows[0]) throw new HttpError(422, 'OFFER_INVALID');
  return rows[0];
}

async function resolveCoupon(db, restaurant, couponId, { customer, bill, lock }) {
  if (!customer) throw new HttpError(401, 'SIGN_IN_REQUIRED');
  const { rows: [k] } = await db.query(
    `SELECT k.*, c.kind, c.value, c.item_name, c.max_minor, c.min_spend_minor
       FROM coupons k JOIN campaigns c ON c.id = k.campaign_id
      WHERE k.id = $1 AND k.customer_id = $2 AND k.restaurant_id = $3 AND k.status = 'available'
        AND k.valid_from <= now() AND k.valid_until > now()
      ${lock ? 'FOR UPDATE OF k' : ''}`,
    [couponId, customer.id, restaurant.id],
  );
  if (!k) throw new HttpError(422, 'COUPON_INVALID');
  if (lock) {
    const busy = await db.query(
      `SELECT 1 FROM payments WHERE coupon_id = $1 AND status = 'pending' AND expires_at > now() LIMIT 1`, [k.id],
    );
    if (busy.rowCount) throw new HttpError(409, 'COUPON_IN_USE');
  }
  let offer;
  if (k.kind === 'free_item') {
    const want = k.item_name.trim().toLowerCase();
    const item = bill?.items.find((i) => [i.name_en, i.name_ar].some((n) => n.trim().toLowerCase() === want));
    if (!item) throw new HttpError(422, 'COUPON_ITEM_NOT_ON_BILL');
    offer = { kind: 'fixed', value: Math.min(item.unit_price_minor, k.value) };
  } else {
    offer = { kind: k.kind, value: k.value, max_minor: k.max_minor, min_spend_minor: k.min_spend_minor };
  }
  return { ...offer, id: null, coupon_id: k.id, min_spend_minor: k.min_spend_minor };
}

/** Public, read-only view of a table's bill. Exposes nothing about other diners. */
export async function publicView(ctx, token, customer = null) {
  const db = ctx.pool;
  const r = await findTable(db, token);
  if (!r) throw new HttpError(404, 'NOT_FOUND');
  const sync = await syncTableBill(ctx, r, r);
  const bill = await loadOpenBill(db, r.table_id);
  const offers = await activeBankOffers(db, r);
  return {
    restaurant: {
      slug: r.slug, name_en: r.name_en, name_ar: r.name_ar, currency: r.currency,
      logo_url: r.logo_url, cover_url: r.cover_url, brand_color: r.brand_color, menu: r.menu,
    },
    table: { label: r.label },
    pos_unavailable: Boolean(sync.stale),
    require_phone: r.require_phone,
    loyalty: { enabled: r.loyalty_enabled, points_per_unit: r.points_per_unit },
    me: customer ? await dinerContext(db, r, customer) : null,
    policy: policyOf(r),
    offers,
    bill: bill && {
      total_minor: bill.total_minor,
      vat_minor: bill.vat_minor,
      remaining_minor: remainingOf(bill),
      settled_minor: bill.settled_minor,
      payments_count: bill.payments_count,
      items: bill.items.map(({ id, name_en, name_ar, unit_price_minor, qty, settled_qty }) => ({
        id, name_en, name_ar, unit_price_minor, qty, settled_qty,
      })),
    },
  };
}

export async function quoteFor(db, token, body, customer = null) {
  const r = await findTable(db, token);
  if (!r) throw new HttpError(404, 'NOT_FOUND');
  const bill = await loadOpenBill(db, r.table_id);
  if (!bill) throw new HttpError(404, 'NO_OPEN_BILL');
  const offer = await resolveDiscount(db, r, body, { customer, bill });
  return wrapBilling(() => ({ ...quote(bill, body, policyOf(r), offer), offer_id: offer?.id ?? null }));
}

/** What a signed-in diner sees at this restaurant: points balance and usable coupons. */
async function dinerContext(db, r, customer) {
  const [pts, coupons] = await Promise.all([
    db.query('SELECT coalesce(sum(points),0)::int AS p FROM loyalty_ledger WHERE restaurant_id = $1 AND customer_id = $2', [r.id, customer.id]),
    db.query(
      `SELECT k.id, k.valid_until, c.name, c.kind, c.value, c.item_name, c.max_minor, c.min_spend_minor
         FROM coupons k JOIN campaigns c ON c.id = k.campaign_id
        WHERE k.customer_id = $1 AND k.restaurant_id = $2 AND k.status = 'available'
          AND k.valid_from <= now() AND k.valid_until > now() ORDER BY k.valid_until`,
      [customer.id, r.id],
    ),
  ]);
  return { name: customer.name, needs_profile: !customer.name, points: pts.rows[0].p, coupons: coupons.rows };
}

function wrapBilling(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BillingError) throw new HttpError(422, e.code);
    throw e;
  }
}

const canonical = (o) => JSON.stringify(o, Object.keys(o).sort());

/**
 * Creates a pending payment. The amount is computed ONLY on the server.
 * The bill row is locked so concurrent diners cannot over-pay the same bill.
 */
export async function createPayment(ctx, { token, body, idemKey, ip, customer = null }) {
  const { pool, provider, config, log } = ctx;
  // Live POS bills must be fresh before anyone pays: never charge against a stale bill.
  const pre = await findTable(pool, token);
  if (!pre) throw new HttpError(404, 'NOT_FOUND');
  if (pre.require_phone && !customer) throw new HttpError(401, 'SIGN_IN_REQUIRED');
  const sync = await syncTableBill(ctx, pre, pre);
  if (sync.stale) throw new HttpError(503, 'POS_UNAVAILABLE');

  const requestHash = crypto.createHash('sha256').update(canonical({
    split: JSON.stringify(body.split), tip: JSON.stringify(body.tip ?? null),
    offer_id: body.offer_id ?? null, promo_code: body.promo_code ?? null, coupon_id: body.coupon_id ?? null,
    customer: customer?.id ?? null,
  })).digest('hex');

  const created = await tx(pool, async (c) => {
    const r = await findTable(c, token);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    const bill = await loadOpenBill(c, r.table_id, { lock: true });
    if (!bill) throw new HttpError(404, 'NO_OPEN_BILL');

    const prev = await c.query('SELECT * FROM payments WHERE bill_id = $1 AND idempotency_key = $2', [bill.id, idemKey]);
    if (prev.rows[0]) {
      if (prev.rows[0].request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
      return { payment: prev.rows[0], restaurant: r, replay: true };
    }

    const offer = await resolveDiscount(c, r, body, { customer, bill, lock: true });
    const q = wrapBilling(() => quote(bill, body, policyOf(r), offer));

    const ins = await c.query(
      `INSERT INTO payments (bill_id, restaurant_id, currency, share_minor, discount_minor, fee_minor, tip_minor,
                             total_minor, split, items, offer_id, allowed_bins, provider, idempotency_key,
                             request_hash, marketing_consent, client_ip, expires_at, customer_id, coupon_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(mins => $18), $19, $20)
       RETURNING *`,
      [bill.id, r.id, bill.currency, q.share_minor, q.discount_minor, q.fee_minor, q.tip_minor, q.total_minor,
        body.split, q.items ? JSON.stringify(q.items) : null, offer?.id ?? null, offer?.bin_prefixes ?? null,
        provider.name, idemKey, requestHash, !!body.marketing_consent, ip, config.RESERVATION_TTL_MIN,
        customer?.id ?? null, offer?.coupon_id ?? null],
    );
    await audit(c, {
      actorType: 'diner', restaurantId: r.id, action: 'payment.created', target: ins.rows[0].id, ip,
      meta: { bill_id: bill.id, total_minor: q.total_minor, split: body.split.mode },
    });
    return { payment: ins.rows[0], restaurant: r, replay: false };
  });

  const { payment, restaurant } = created;
  if (payment.redirect_url) return payment;
  if (created.replay) throw new HttpError(409, 'PAYMENT_IN_PROGRESS');

  // Network call to the provider happens OUTSIDE the DB transaction/lock.
  try {
    const { provider_ref, redirect_url } = await provider.createCheckout({ payment, restaurant });
    const { rows } = await pool.query(
      `UPDATE payments SET provider_ref = $2, redirect_url = $3 WHERE id = $1 RETURNING *`,
      [payment.id, provider_ref, redirect_url],
    );
    return rows[0];
  } catch (e) {
    log.error({ err: e.message, payment: payment.id }, 'provider createCheckout failed');
    await pool.query(`UPDATE payments SET status = 'failed', flag = 'provider_error' WHERE id = $1`, [payment.id]);
    throw new HttpError(502, 'PROVIDER_UNAVAILABLE');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applies a VERIFIED provider event. Idempotent (event de-duplication + state checks). */
export async function applyProviderEvent(pool, providerName, evt) {
  if (!UUID.test(String(evt.payment_id))) return 'ignored';
  return tx(pool, async (c) => {
    const dup = await c.query(
      'INSERT INTO webhook_events(provider, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1',
      [providerName, String(evt.event_id)],
    );
    if (!dup.rowCount) return 'duplicate';

    const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 AND provider = $2 FOR UPDATE', [evt.payment_id, providerName]);
    const p = rows[0];
    if (!p || p.provider_ref !== evt.provider_ref) return 'ignored';
    if (p.status === 'captured' || p.status === 'refunded') return 'noop';

    await c.query('SELECT id FROM bills WHERE id = $1 FOR UPDATE', [p.bill_id]);

    if (evt.status === 'failed') {
      await c.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [p.id]);
      await audit(c, { actorType: 'provider', actorId: providerName, restaurantId: p.restaurant_id, action: 'payment.failed', target: p.id });
      return 'failed';
    }
    if (evt.status !== 'captured') return 'pending';

    const flags = [];
    if (evt.amount_minor !== p.total_minor || evt.currency !== p.currency) {
      // Never mark as paid if the provider charged a different amount than we computed.
      await c.query(`UPDATE payments SET flag = 'amount_mismatch' WHERE id = $1`, [p.id]);
      await audit(c, {
        actorType: 'provider', actorId: providerName, restaurantId: p.restaurant_id, action: 'payment.amount_mismatch',
        target: p.id, meta: { expected: p.total_minor, got: evt.amount_minor, currency: evt.currency },
      });
      return 'mismatch';
    }
    const bin = evt.card?.bin ? String(evt.card.bin) : null;
    // Bank offers: the card actually used must belong to the offer's BIN ranges.
    const binOk = (pre) => bin.startsWith(pre) || pre.startsWith(bin); // provider may return 6 or 8 digits
    if (p.allowed_bins?.length && !(bin && p.allowed_bins.some(binOk))) {
      flags.push('bin_mismatch');
    }
    if (p.offer_id) {
      const red = await c.query(
        `UPDATE offers SET redemptions = redemptions + 1
          WHERE id = $1 AND (max_redemptions IS NULL OR redemptions < max_redemptions)`,
        [p.offer_id],
      );
      if (!red.rowCount) flags.push('offer_exhausted');
    }
    if (p.coupon_id) {
      const red = await c.query(
        `UPDATE coupons SET status = 'redeemed', redeemed_payment_id = $2, redeemed_at = now()
          WHERE id = $1 AND status = 'available'`, [p.coupon_id, p.id],
      );
      if (!red.rowCount) flags.push('coupon_reused');
    }
    if (p.customer_id) {
      // Loyalty points on what the diner spent at the restaurant (not on tips or fees).
      const { rows: [rest] } = await c.query('SELECT loyalty_enabled, points_per_unit FROM restaurants WHERE id = $1', [p.restaurant_id]);
      const pts = rest.loyalty_enabled
        ? Math.floor(((p.share_minor - p.discount_minor) * rest.points_per_unit) / 10 ** CURRENCIES[p.currency].decimals)
        : 0;
      if (pts > 0) {
        await c.query(
          `INSERT INTO loyalty_ledger(restaurant_id, customer_id, points, reason, payment_id)
           VALUES ($1,$2,$3,'payment',$4) ON CONFLICT (payment_id) DO NOTHING`,
          [p.restaurant_id, p.customer_id, pts, p.id],
        );
      }
    }
    const { rows: bills } = await c.query(
      `SELECT b.total_minor, b.external_paid_minor + coalesce(sum(p.share_minor) FILTER (WHERE p.status = 'captured'), 0)::bigint AS captured
         FROM bills b LEFT JOIN payments p ON p.bill_id = b.id WHERE b.id = $1 GROUP BY b.id`,
      [p.bill_id],
    );
    if (bills[0].captured + p.share_minor > bills[0].total_minor) flags.push('overpaid');

    await c.query(
      `UPDATE payments SET status = 'captured', captured_at = now(), card_brand = $2, card_last4 = $3, card_bin = $4, flag = $5
        WHERE id = $1`,
      [p.id, evt.card?.brand ?? null, evt.card?.last4 ?? null, bin?.slice(0, 8) ?? null, flags.join(',') || null],
    );
    const fullyPaid = bills[0].captured + p.share_minor >= bills[0].total_minor;
    if (fullyPaid) {
      await c.query(`UPDATE bills SET status = 'paid', closed_at = now() WHERE id = $1 AND status = 'open'`, [p.bill_id]);
    }
    // Record the payment in the restaurant's POS: automatically when the POS supports it,
    // otherwise queued for staff to confirm in the dashboard.
    await c.query(
      `INSERT INTO pos_writebacks(payment_id, restaurant_id, mode)
       SELECT $1, $2, CASE WHEN pc.provider = 'simphony' AND b.source = 'simphony' THEN 'auto' ELSE 'manual' END
         FROM pos_connections pc JOIN bills b ON b.id = $3
        WHERE pc.restaurant_id = $2 AND pc.status <> 'disabled'
       ON CONFLICT DO NOTHING`,
      [p.id, p.restaurant_id, p.bill_id],
    );
    await c.query(
      `INSERT INTO outbox(restaurant_id, type, payload) VALUES ($1, 'payment.captured', $2)`,
      [p.restaurant_id, { payment_id: p.id, bill_id: p.bill_id, share_minor: p.share_minor, tip_minor: p.tip_minor,
        discount_minor: p.discount_minor, currency: p.currency, bill_fully_paid: fullyPaid }],
    );
    await audit(c, {
      actorType: 'provider', actorId: providerName, restaurantId: p.restaurant_id, action: 'payment.captured',
      target: p.id, meta: { total_minor: p.total_minor, flags },
    });
    return 'captured';
  });
}

export async function expireStalePayments(pool) {
  const { rowCount } = await pool.query(
    `UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() - interval '1 hour'`,
  );
  return rowCount;
}

export async function paymentStatus(db, id) {
  if (!UUID.test(String(id))) throw new HttpError(404, 'NOT_FOUND');
  const { rows } = await db.query(
    `SELECT p.id, p.status, p.currency, p.share_minor, p.discount_minor, p.fee_minor, p.tip_minor, p.total_minor,
            p.card_brand, p.card_last4, p.captured_at, r.name_en, r.name_ar, t.public_token,
            r.google_review_url, (SELECT points FROM loyalty_ledger WHERE payment_id = p.id) AS points_earned,
            EXISTS (SELECT 1 FROM ratings WHERE payment_id = p.id) AS rated
       FROM payments p JOIN bills b ON b.id = p.bill_id JOIN dining_tables t ON t.id = b.table_id
       JOIN restaurants r ON r.id = p.restaurant_id
      WHERE p.id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND');
  return rows[0];
}

/** One rating per captured payment, within 48 hours. Signed-in payments can only be rated by their diner. */
export async function ratePayment(pool, id, { stars, comment }, customer) {
  if (!UUID.test(String(id))) throw new HttpError(404, 'NOT_FOUND');
  const { rows: [p] } = await pool.query(
    `SELECT p.id, p.restaurant_id, p.customer_id, p.status, p.captured_at, r.google_review_url
       FROM payments p JOIN restaurants r ON r.id = p.restaurant_id WHERE p.id = $1`, [id],
  );
  if (!p || p.status !== 'captured' || Date.now() - p.captured_at.getTime() > 48 * 3600_000) throw new HttpError(404, 'NOT_FOUND');
  if (p.customer_id && p.customer_id !== customer?.id) throw new HttpError(403, 'FORBIDDEN');
  const ins = await pool.query(
    `INSERT INTO ratings(payment_id, restaurant_id, customer_id, stars, comment) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`, [p.id, p.restaurant_id, p.customer_id, stars, comment || null],
  );
  if (!ins.rowCount) throw new HttpError(409, 'ALREADY_RATED');
  // Same Google link for every rating (Google forbids asking only happy diners).
  return { ok: true, google_review_url: p.google_review_url };
}
