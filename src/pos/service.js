import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { CURRENCIES } from '../../shared/billing.js';
import { PosError } from './http.js';

const FRESH_MS = 8_000;          // don't hit the POS more than once per 8s per table
const STALE_OK_MS = 60_000;      // a payment may use a bill synced within the last minute
const MAX_ATTEMPTS = 8;

const LIVE = `(p.status = 'captured' OR (p.status = 'pending' AND p.expires_at > now()))`;

/** Loads a restaurant's POS connection with decrypted secrets and a saver for rotated tokens. */
export async function loadConnection(ctx, restaurantId) {
  const { rows } = await ctx.pool.query('SELECT * FROM pos_connections WHERE restaurant_id = $1', [restaurantId]);
  const row = rows[0];
  if (!row) return null;
  const connector = ctx.connectors[row.provider];
  const conn = {
    config: row.config ?? {},
    secrets: row.secrets_enc ? JSON.parse(ctx.cipher.decrypt(row.secrets_enc)) : null,
    async saveSecrets(next) {
      conn.secrets = next;
      await ctx.pool.query('UPDATE pos_connections SET secrets_enc = $2, updated_at = now() WHERE restaurant_id = $1', [
        restaurantId, ctx.cipher.encrypt(JSON.stringify(next)),
      ]);
    },
  };
  return { row, connector, conn };
}

async function markHealth(ctx, restaurantId, err) {
  await ctx.pool.query(
    `UPDATE pos_connections SET status = CASE WHEN $2::text IS NULL THEN 'active' ELSE 'error' END,
            last_error = $2, last_sync_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sync_at END
      WHERE restaurant_id = $1 AND status <> 'disabled' AND (status <> 'pending' OR $2::text IS NULL)`,
    [restaurantId, err ? `${err.code}${err.message && err.message !== err.code ? `: ${err.message}` : ''}`.slice(0, 300) : null],
  );
}

const itemsKey = (items) => JSON.stringify(items.map((i) => [i.name_en, i.unit_price_minor, i.qty]));

/**
 * Pulls the table's open bill from the POS and mirrors it locally.
 * Returns { synced, stale, error? }. Never throws for POS problems — callers decide.
 */
export async function syncTableBill(ctx, restaurant, table, { force = false } = {}) {
  const c = await loadConnection(ctx, restaurant.id);
  if (!c || !c.connector?.capabilities.liveBill || c.row.status === 'disabled' || c.row.status === 'pending') {
    return { synced: false };
  }
  const local = (await ctx.pool.query(
    `SELECT id, synced_at FROM bills WHERE table_id = $1 AND status = 'open'`, [table.table_id],
  )).rows[0];
  if (!force && local?.synced_at && Date.now() - local.synced_at.getTime() < FRESH_MS) return { synced: true };

  let remote;
  try {
    remote = await c.connector.fetchOpenBill(c.conn, table, { decimals: CURRENCIES[restaurant.currency].decimals });
    await markHealth(ctx, restaurant.id, null);
  } catch (e) {
    if (!(e instanceof PosError)) throw e;
    ctx.log.warn({ restaurant: restaurant.id, code: e.code }, 'POS sync failed');
    await markHealth(ctx, restaurant.id, e);
    const age = local?.synced_at ? Date.now() - local.synced_at.getTime() : Infinity;
    return { synced: false, stale: age > STALE_OK_MS, error: e.code };
  }

  await tx(ctx.pool, async (db) => {
    // Serialize syncs of the same table across requests/instances.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sync:${table.table_id}`]);
    const cur = (await db.query(
      `SELECT * FROM bills WHERE table_id = $1 AND status = 'open' FOR UPDATE`, [table.table_id],
    )).rows[0];
    const live = cur
      ? (await db.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE items IS NOT NULL)::int AS by_items FROM payments p WHERE bill_id = $1 AND ${LIVE}`,
        [cur.id],
      )).rows[0]
      : { n: 0, by_items: 0 };

    const voidBill = async (b, why) => {
      await db.query(
        `UPDATE bills SET status = 'void', closed_at = now(),
                external_ref = CASE WHEN external_ref IS NULL THEN NULL ELSE external_ref || ':void:' || id END
          WHERE id = $1`,
        [b.id],
      );
      await audit(db, { actorType: 'system', restaurantId: restaurant.id, action: 'bill.voided_by_pos_sync', target: b.id, meta: { why } });
    };

    if (!remote) {
      // Order closed/voided in the POS. Keep the bill only while a diner is mid-payment.
      if (cur && cur.source === c.row.provider && live.n === 0) await voidBill(cur, 'closed_in_pos');
      else if (cur) await db.query('UPDATE bills SET synced_at = now() WHERE id = $1', [cur.id]);
      return;
    }

    if (cur && cur.external_ref !== remote.external_ref) {
      if (live.n > 0) {
        ctx.log.warn({ bill: cur.id }, 'POS shows a different order but the local bill has payments');
        await db.query('UPDATE bills SET synced_at = now() WHERE id = $1', [cur.id]);
        return;
      }
      await voidBill(cur, 'replaced_by_pos_order');
    }
    const same = cur && cur.external_ref === remote.external_ref ? cur : null;

    // Money already paid at the POS by other means (cash, card machine), excluding Orderize
    // payments that staff/auto write-back already recorded there — never count those twice.
    let ours = 0;
    if (same) {
      ours = (await db.query(
        `SELECT coalesce(sum(p.share_minor),0)::bigint AS s FROM payments p JOIN pos_writebacks w ON w.payment_id = p.id
          WHERE p.bill_id = $1 AND p.status = 'captured' AND w.status = 'done'`, [same.id],
      )).rows[0].s;
    }
    const externalPaid = Math.max(0, remote.paid_minor - ours);
    const total = Math.max(1, remote.total_minor);
    const vat = Math.min(Math.max(0, remote.vat_minor || 0), total);

    if (same) {
      await db.query(
        `UPDATE bills SET total_minor = $2, vat_minor = $3, external_paid_minor = $4, synced_at = now() WHERE id = $1`,
        [same.id, total, vat, externalPaid],
      );
      const old = (await db.query('SELECT name_en, unit_price_minor, qty FROM bill_items WHERE bill_id = $1 ORDER BY position', [same.id])).rows;
      // Replace the item list only if nobody is paying "by item" (their item ids must stay valid).
      if (itemsKey(old) !== itemsKey(remote.items) && live.by_items === 0) {
        await db.query('DELETE FROM bill_items WHERE bill_id = $1', [same.id]);
        await insertItems(db, same.id, remote.items);
      }
      return;
    }

    const ins = await db.query(
      `INSERT INTO bills(restaurant_id, table_id, external_ref, currency, total_minor, vat_minor, source, external_paid_minor, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING id`,
      [restaurant.id, table.table_id, remote.external_ref, restaurant.currency, total, vat, c.row.provider, externalPaid],
    );
    await insertItems(db, ins.rows[0].id, remote.items);
    await audit(db, { actorType: 'system', restaurantId: restaurant.id, action: 'bill.imported_from_pos', target: ins.rows[0].id, meta: { provider: c.row.provider } });
  });
  return { synced: true };
}

async function insertItems(db, billId, items) {
  let pos = 0;
  for (const i of items.slice(0, 200)) {
    await db.query(
      'INSERT INTO bill_items(bill_id, name_en, name_ar, unit_price_minor, qty, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [billId, i.name_en, i.name_ar, i.unit_price_minor, Math.min(i.qty, 999), pos++],
    );
  }
}

// ---------------- write-back worker

export async function processWritebacks(ctx, { limit = 20 } = {}) {
  // Lease rows in a short transaction so several instances never post the same payment twice.
  const leased = await tx(ctx.pool, async (db) => (await db.query(
    `UPDATE pos_writebacks SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
      WHERE payment_id IN (
        SELECT payment_id FROM pos_writebacks
         WHERE status = 'pending' AND mode = 'auto' AND next_attempt_at <= now()
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit],
  )).rows);

  let done = 0;
  for (const w of leased) {
    const { rows: [p] } = await ctx.pool.query(
      `SELECT p.*, b.external_ref, b.source, r.currency FROM payments p JOIN bills b ON b.id = p.bill_id
         JOIN restaurants r ON r.id = p.restaurant_id WHERE p.id = $1`, [w.payment_id],
    );
    const c = await loadConnection(ctx, w.restaurant_id);
    try {
      if (!c?.connector?.postPayment || c.row.provider !== p.source) throw new PosError('POS_WRITEBACK_UNSUPPORTED');
      const r = await c.connector.postPayment(c.conn, {
        bill: { external_ref: p.external_ref }, payment: p, decimals: CURRENCIES[p.currency].decimals,
      });
      await ctx.pool.query(
        `UPDATE pos_writebacks SET status = 'done', done_at = now(), external_ref = $2, last_error = NULL WHERE payment_id = $1`,
        [w.payment_id, r.external_ref ?? null],
      );
      await audit(ctx.pool, { actorType: 'system', restaurantId: w.restaurant_id, action: 'pos.payment_recorded', target: w.payment_id });
      done++;
    } catch (e) {
      const retry = e instanceof PosError && e.retryable && w.attempts < MAX_ATTEMPTS;
      await ctx.pool.query(
        `UPDATE pos_writebacks SET status = $2, last_error = $3,
                next_attempt_at = now() + make_interval(secs => $4) WHERE payment_id = $1`,
        [w.payment_id, retry ? 'pending' : 'failed', String(e.code ?? 'ERROR').slice(0, 200), 30 * 2 ** w.attempts],
      );
      ctx.log.warn({ payment: w.payment_id, code: e.code, retry }, 'POS write-back failed');
    }
  }
  return { leased: leased.length, done };
}

// ---------------- OAuth connect flow (Foodics)

export async function startOAuth(ctx, { restaurantId, userId, provider }) {
  const connector = ctx.connectors[provider];
  if (!connector?.capabilities.oauth) throw new PosError('POS_OAUTH_UNSUPPORTED');
  if (!connector.isConfigured()) throw new PosError('POS_PLATFORM_NOT_CONFIGURED');
  const state = randomToken(32);
  await ctx.pool.query(
    `INSERT INTO oauth_states(state_hash, restaurant_id, user_id, provider, expires_at)
     VALUES ($1,$2,$3,$4, now() + interval '10 minutes')`,
    [sha256(state), restaurantId, userId, provider],
  );
  return connector.authorizeUrl({ state, redirectUri: redirectUri(ctx, provider) });
}

export const redirectUri = (ctx, provider) => `${ctx.config.PUBLIC_BASE_URL}/api/integrations/${provider}/callback`;

export async function finishOAuth(ctx, { provider, code, state }) {
  if (typeof state !== 'string' || typeof code !== 'string' || code.length > 2048) throw new PosError('OAUTH_INVALID');
  // Single use: the row is deleted as it is read.
  const { rows: [s] } = await ctx.pool.query(
    'DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 AND expires_at > now() RETURNING *',
    [sha256(state), provider],
  );
  if (!s) throw new PosError('OAUTH_STATE_INVALID');
  const connector = ctx.connectors[provider];
  const secrets = await connector.exchangeCode({ code, redirectUri: redirectUri(ctx, provider) });
  await ctx.pool.query(
    `INSERT INTO pos_connections(restaurant_id, provider, secrets_enc, status, config)
     VALUES ($1,$2,$3,'pending','{}')
     ON CONFLICT (restaurant_id) DO UPDATE SET provider = EXCLUDED.provider, secrets_enc = EXCLUDED.secrets_enc,
       status = 'pending', config = '{}', last_error = NULL, updated_at = now()`,
    [s.restaurant_id, provider, ctx.cipher.encrypt(JSON.stringify(secrets))],
  );
  await audit(ctx.pool, { actorType: 'user', actorId: s.user_id, restaurantId: s.restaurant_id, action: 'pos.connected', meta: { provider } });
  return s;
}
