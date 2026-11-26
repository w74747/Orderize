// Table ordering: diners send orders from the menu; staff (dashboard or a paired order station)
// accept, prepare and serve them. Accepted orders are added to the table's bill automatically
// unless the restaurant runs a live POS (then staff key the order into the POS).
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError, findTable } from './bills.js';

const MAX_LINES = 30;
const MAX_PENDING_PER_TABLE = 3;
const ACTIVE = ['new', 'preparing', 'ready'];
const NEXT = { new: ['preparing', 'cancelled'], preparing: ['ready', 'served'], ready: ['served'] };

const label = (o, lang) => o[`name_${lang}`] || o[`name_${lang === 'en' ? 'ar' : 'en'}`];

/** Server-side pricing. Never trusts prices or option rules from the browser. */
export function priceLines(items, lines) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = [];
  let subtotal = 0;
  for (const line of lines) {
    const it = byId.get(line.item_id);
    if (!it) throw new HttpError(422, 'ITEM_NOT_FOUND');
    if (!it.available) throw new HttpError(409, 'ITEM_SOLD_OUT');
    const picked = new Set(line.options ?? []);
    const chosen = [];
    for (const g of it.options ?? []) {
      const sel = g.choices.filter((c) => picked.has(c.id));
      if (sel.length < (g.min ?? 0) || sel.length > (g.max ?? 1)) throw new HttpError(422, 'OPTIONS_INVALID');
      for (const c of sel) { chosen.push(c); picked.delete(c.id); }
    }
    if (picked.size) throw new HttpError(422, 'OPTIONS_INVALID');
    const unit = Number(it.price_minor) + chosen.reduce((s, c) => s + Number(c.price_minor ?? 0), 0);
    subtotal += unit * line.qty;
    out.push({
      item_id: it.id, name_en: it.name_en, name_ar: it.name_ar, qty: line.qty, unit_price_minor: unit,
      options: chosen.map((c) => ({ name_en: c.name_en, name_ar: c.name_ar, price_minor: Number(c.price_minor ?? 0) })),
      note: line.note || null,
    });
  }
  if (subtotal <= 0 || subtotal > 100_000_000) throw new HttpError(422, 'INVALID_TOTAL');
  return { lines: out, subtotal };
}

export async function placeOrder(ctx, { token, body, customer, ip }) {
  const { pool } = ctx;
  const r = await findTable(pool, token);
  if (!r) throw new HttpError(404, 'NOT_FOUND');
  if (r.menu_mode !== 'order') throw new HttpError(403, 'ORDERING_DISABLED');
  if (r.order_requires_login && !customer) throw new HttpError(401, 'SIGN_IN_REQUIRED');
  if (body.items.length > MAX_LINES) throw new HttpError(422, 'TOO_MANY_LINES');

  const ids = [...new Set(body.items.map((l) => l.item_id))];
  const { rows: items } = await pool.query(
    'SELECT id, name_en, name_ar, price_minor, available, options FROM menu_items WHERE restaurant_id = $1 AND id = ANY($2::uuid[])',
    [r.id, ids],
  );
  const { lines, subtotal } = priceLines(items, body.items);

  return tx(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`orders:${r.id}`]);
    const dup = await db.query('SELECT * FROM orders WHERE table_id = $1 AND client_key = $2', [r.table_id, body.client_key]);
    if (dup.rows[0]) return publicOrder(dup.rows[0]); // retried request: same order back
    const pending = (await db.query(`SELECT count(*)::int AS n FROM orders WHERE table_id = $1 AND status = 'new'`, [r.table_id])).rows[0].n;
    if (pending >= MAX_PENDING_PER_TABLE) throw new HttpError(429, 'TOO_MANY_PENDING_ORDERS');
    const { rows: [{ n }] } = await db.query(
      `SELECT coalesce(max(number),0)+1 AS n FROM orders WHERE restaurant_id = $1 AND created_at >= date_trunc('day', now())`, [r.id],
    );
    const { rows: [o] } = await db.query(
      `INSERT INTO orders(restaurant_id, table_id, customer_id, number, items, subtotal_minor, currency, note, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [r.id, r.table_id, customer?.id ?? null, n, JSON.stringify(lines), subtotal, r.currency, body.note || null, body.client_key],
    );
    await audit(db, { actorType: 'diner', actorId: customer?.id ?? null, restaurantId: r.id, action: 'order.placed', target: o.id, ip, meta: { subtotal_minor: subtotal } });
    return publicOrder(o);
  });
}

function publicOrder(o) {
  return {
    id: o.id, number: o.number, status: o.status, subtotal_minor: Number(o.subtotal_minor), currency: o.currency,
    items: o.items.map((l) => ({ name_en: l.name_en, name_ar: l.name_ar, qty: l.qty, options: l.options, note: l.note })),
    note: o.note, cancel_reason: o.cancel_reason, created_at: o.created_at,
  };
}

/** Orders of the current party at this table (open bill, or not yet on a bill and recent). */
export async function tableOrders(pool, token) {
  const r = await findTable(pool, token);
  if (!r) throw new HttpError(404, 'NOT_FOUND');
  const { rows } = await pool.query(
    `SELECT o.* FROM orders o LEFT JOIN bills b ON b.id = o.bill_id
      WHERE o.table_id = $1 AND o.created_at > now() - interval '8 hours'
        AND ((o.bill_id IS NOT NULL AND b.status = 'open')
          OR (o.bill_id IS NULL AND o.created_at > now() - interval '3 hours' AND o.status <> 'served'))
      ORDER BY o.created_at DESC LIMIT 20`,
    [r.table_id],
  );
  return { orders: rows.map(publicOrder) };
}

export async function callWaiter(pool, token, kind, ip) {
  const r = await findTable(pool, token);
  if (!r) throw new HttpError(404, 'NOT_FOUND');
  if (!r.waiter_call_enabled) throw new HttpError(403, 'WAITER_CALL_DISABLED');
  await pool.query(
    `INSERT INTO waiter_calls(restaurant_id, table_id, kind) VALUES ($1,$2,$3)
     ON CONFLICT (table_id, kind) WHERE resolved_at IS NULL DO NOTHING`,
    [r.id, r.table_id, kind],
  );
  return { ok: true };
}

// ---------------------------------------------------------------- staff side

export async function board(pool, restaurantId) {
  const [orders, calls] = await Promise.all([
    pool.query(
      `SELECT o.*, t.label AS table_label FROM orders o JOIN dining_tables t ON t.id = o.table_id
        WHERE o.restaurant_id = $1
          AND (o.status = ANY($2) OR coalesce(o.served_at, o.cancelled_at) > now() - interval '3 hours')
        ORDER BY o.created_at DESC LIMIT 200`,
      [restaurantId, ACTIVE],
    ),
    pool.query(
      `SELECT c.id, c.kind, c.created_at, t.label AS table_label FROM waiter_calls c JOIN dining_tables t ON t.id = c.table_id
        WHERE c.restaurant_id = $1 AND c.resolved_at IS NULL ORDER BY c.created_at`, [restaurantId],
    ),
  ]);
  return {
    orders: orders.rows.map((o) => ({
      id: o.id, number: o.number, status: o.status, table: o.table_label, items: o.items, note: o.note,
      subtotal_minor: Number(o.subtotal_minor), currency: o.currency, pos_entry_needed: o.pos_entry_needed,
      cancel_reason: o.cancel_reason, created_at: o.created_at, accepted_at: o.accepted_at,
    })),
    calls: calls.rows,
    server_time: new Date().toISOString(),
  };
}

const VAT = (amount, bps) => Math.round((amount * bps) / (10000 + bps)); // prices include VAT

/** Adds an accepted order to the table's open bill (opening one if needed). */
async function attachToBill(db, o, r) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bill:${o.table_id}`]);
  const live = await db.query(
    `SELECT 1 FROM pos_connections WHERE restaurant_id = $1 AND provider IN ('foodics','simphony') AND status = 'active'`, [r.id],
  );
  let { rows: [bill] } = await db.query(`SELECT * FROM bills WHERE table_id = $1 AND status = 'open' FOR UPDATE`, [o.table_id]);
  if (live.rowCount || (bill && bill.source !== 'manual')) return { bill_id: null, pos_entry_needed: true };

  const sub = Number(o.subtotal_minor);
  const vat = VAT(sub, r.vat_bps);
  if (bill) {
    if (Number(bill.total_minor) + sub > 100_000_000) throw new HttpError(422, 'INVALID_TOTAL');
    await db.query('UPDATE bills SET total_minor = total_minor + $2, vat_minor = vat_minor + $3 WHERE id = $1', [bill.id, sub, vat]);
  } else {
    ({ rows: [bill] } = await db.query(
      `INSERT INTO bills(restaurant_id, table_id, currency, total_minor, vat_minor, source)
       VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *`, [r.id, o.table_id, r.currency, sub, vat],
    ));
  }
  let pos = (await db.query('SELECT coalesce(max(position),0)+1 AS p FROM bill_items WHERE bill_id = $1', [bill.id])).rows[0].p;
  for (const l of o.items) {
    const suffix = (lang) => (l.options?.length ? ` (${l.options.map((c) => label(c, lang)).join(', ')})` : '');
    await db.query(
      'INSERT INTO bill_items(bill_id, name_en, name_ar, unit_price_minor, qty, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [bill.id, `${label(l, 'en')}${suffix('en')}`.slice(0, 200), `${label(l, 'ar')}${suffix('ar')}`.slice(0, 200), l.unit_price_minor, l.qty, pos++],
    );
  }
  return { bill_id: bill.id, pos_entry_needed: false };
}

/** actor: { restaurantId, label, actorType, actorId, ip } */
export async function setOrderStatus(pool, actor, orderId, { status, reason }) {
  return tx(pool, async (db) => {
    const { rows: [o] } = await db.query('SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [orderId, actor.restaurantId]);
    if (!o) throw new HttpError(404, 'NOT_FOUND');
    if (!(NEXT[o.status] ?? []).includes(status)) throw new HttpError(409, 'INVALID_TRANSITION');
    const { rows: [r] } = await db.query('SELECT id, currency, vat_bps FROM restaurants WHERE id = $1', [actor.restaurantId]);
    let extra = {};
    if (status === 'preparing') extra = await attachToBill(db, o, r);
    const stamp = { preparing: 'accepted_at', ready: 'ready_at', served: 'served_at', cancelled: 'cancelled_at' }[status];
    const { rows: [u] } = await db.query(
      `UPDATE orders SET status = $2, ${stamp} = now(), handled_by = $3,
              cancel_reason = CASE WHEN $2 = 'cancelled' THEN $4 ELSE cancel_reason END,
              bill_id = coalesce($5, bill_id), pos_entry_needed = coalesce($6, pos_entry_needed)
        WHERE id = $1 RETURNING *`,
      [o.id, status, actor.label, reason || null, extra.bill_id ?? null, extra.pos_entry_needed ?? null],
    );
    await audit(db, { actorType: actor.actorType, actorId: actor.actorId, restaurantId: actor.restaurantId, action: `order.${status}`, target: o.id, ip: actor.ip });
    return { id: u.id, status: u.status, bill_id: u.bill_id, pos_entry_needed: u.pos_entry_needed };
  });
}

export async function resolveCall(pool, restaurantId, id) {
  const { rowCount } = await pool.query(
    'UPDATE waiter_calls SET resolved_at = now() WHERE id = $1 AND restaurant_id = $2 AND resolved_at IS NULL', [id, restaurantId],
  );
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
  return { ok: true };
}
