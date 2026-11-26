import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { HttpError } from '../services/bills.js';
import { PosError } from '../pos/http.js';
import { finishOAuth, loadConnection, startOAuth, syncTableBill } from '../pos/service.js';

const short = (max) => z.string().trim().min(1).max(max);

const simphonyBody = z.strictObject({
  host: z.url().max(200),
  org: short(64), loc: short(64),
  rvc: z.coerce.number().int().min(0).max(1e9),
  tender_id: z.coerce.number().int().min(0).max(1e9),
  employee_ref: z.coerce.number().int().min(0).max(1e9),
  client_id: short(400),
  refresh_token: short(8000),
});

/** Admin endpoints. Registered inside the admin plugin, so session + CSRF hooks apply. */
export default async function integrationRoutes(app, { ctx, auth, rid }) {
  const { pool, connectors } = ctx;

  const view = async (restaurantId) => {
    const c = await loadConnection(ctx, restaurantId);
    const counts = (await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND mode = 'manual')::int AS manual_pending,
              count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM pos_writebacks WHERE restaurant_id = $1`, [restaurantId],
    )).rows[0];
    return {
      providers: Object.values(connectors).map((k) => ({
        name: k.name, label: k.label, capabilities: k.capabilities, available: k.isConfigured(),
      })),
      connection: c && {
        provider: c.row.provider, status: c.row.status, config: c.row.config,
        connected: Boolean(c.conn.secrets) || c.row.provider === 'manual',
        last_sync_at: c.row.last_sync_at, last_error: c.row.last_error,
      },
      writebacks: counts,
    };
  };

  app.get('/api/admin/integration', { preHandler: auth('manager') }, async (req) => view(rid(req)));

  app.post('/api/admin/integration/oauth/start', { preHandler: auth('owner') }, async (req) => {
    const provider = z.enum(['foodics']).parse(req.body?.provider);
    return { url: await startOAuth(ctx, { restaurantId: rid(req), userId: req.user.id, provider }) };
  });

  app.post('/api/admin/integration/simphony', { preHandler: auth('owner') }, async (req) => {
    const b = simphonyBody.parse(req.body);
    const connector = connectors.simphony;
    const config = { host: b.host, org: b.org.toLowerCase(), loc: b.loc.toLowerCase(), rvc: b.rvc, tender_id: b.tender_id, employee_ref: b.employee_ref };
    connector.validateConfig(config);
    const conn = { config, secrets: { client_id: b.client_id, refresh_token: b.refresh_token }, async saveSecrets(s) { conn.secrets = s; } };
    await connector.test(conn); // throws PosError on bad host/credentials — nothing is saved
    await pool.query(
      `INSERT INTO pos_connections(restaurant_id, provider, config, secrets_enc, status, last_sync_at)
       VALUES ($1,'simphony',$2,$3,'active', now())
       ON CONFLICT (restaurant_id) DO UPDATE SET provider = 'simphony', config = EXCLUDED.config,
         secrets_enc = EXCLUDED.secrets_enc, status = 'active', last_error = NULL, updated_at = now()`,
      [rid(req), config, ctx.cipher.encrypt(JSON.stringify(conn.secrets))],
    );
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.connected', ip: req.ip, meta: { provider: 'simphony' } });
    return view(rid(req));
  });

  app.post('/api/admin/integration/manual', { preHandler: auth('owner') }, async (req) => {
    await pool.query(
      `INSERT INTO pos_connections(restaurant_id, provider, status) VALUES ($1,'manual','active')
       ON CONFLICT (restaurant_id) DO UPDATE SET provider = 'manual', config = '{}', secrets_enc = NULL,
         status = 'active', last_error = NULL, updated_at = now()`, [rid(req)],
    );
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.connected', ip: req.ip, meta: { provider: 'manual' } });
    return view(rid(req));
  });

  app.post('/api/admin/integration/disconnect', { preHandler: auth('owner') }, async (req) => {
    // Tokens are deleted, not just disabled.
    await pool.query('DELETE FROM pos_connections WHERE restaurant_id = $1', [rid(req)]);
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.disconnected', ip: req.ip });
    return view(rid(req));
  });

  app.get('/api/admin/integration/branches', { preHandler: auth('manager') }, async (req) => {
    const c = await loadConnection(ctx, rid(req));
    if (!c?.connector?.listBranches) throw new HttpError(400, 'NOT_SUPPORTED');
    return { branches: await c.connector.listBranches(c.conn) };
  });

  app.post('/api/admin/integration/branch', { preHandler: auth('owner') }, async (req) => {
    const branchId = short(64).parse(req.body?.branch_id);
    const c = await loadConnection(ctx, rid(req));
    if (c?.row.provider !== 'foodics') throw new HttpError(400, 'NOT_SUPPORTED');
    const branches = await c.connector.listBranches(c.conn);
    if (!branches.some((b) => b.id === branchId)) throw new HttpError(422, 'UNKNOWN_BRANCH');
    await pool.query(
      `UPDATE pos_connections SET config = jsonb_set(config, '{branch_id}', to_jsonb($2::text)), status = 'active', updated_at = now()
        WHERE restaurant_id = $1`, [rid(req), branchId],
    );
    return view(rid(req));
  });

  // Import / match tables from the POS (Foodics). Existing tables are matched by name;
  // new ones get their own random QR token.
  app.post('/api/admin/integration/sync-tables', { preHandler: auth('manager') }, async (req) => {
    const c = await loadConnection(ctx, rid(req));
    if (!c?.connector?.capabilities.listTables) throw new HttpError(400, 'NOT_SUPPORTED');
    const remote = await c.connector.listTables(c.conn);
    const { randomToken } = await import('../lib/crypto.js');
    let created = 0, matched = 0;
    for (const t of remote.slice(0, 500)) {
      const label = t.name.slice(0, 40);
      const up = await pool.query(
        `UPDATE dining_tables SET external_id = $3 WHERE restaurant_id = $1 AND (external_id = $3 OR (external_id IS NULL AND label = $2))`,
        [rid(req), label, t.external_id],
      );
      if (up.rowCount) { matched++; continue; }
      const ins = await pool.query(
        `INSERT INTO dining_tables(restaurant_id, label, public_token, external_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`, [rid(req), label, randomToken(18), t.external_id],
      );
      created += ins.rowCount;
    }
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.tables_synced', ip: req.ip, meta: { created, matched } });
    return { created, matched, total: remote.length };
  });

  app.post('/api/admin/tables/:id/mapping', { preHandler: auth('manager') }, async (req) => {
    const b = z.strictObject({ external_id: short(64).nullable().optional(), external_name: short(64).nullable().optional() }).parse(req.body);
    try {
      const { rowCount } = await pool.query(
        `UPDATE dining_tables SET external_id = coalesce($3, external_id), external_name = $4
          WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, rid(req), b.external_id ?? null, b.external_name ?? null],
      );
      if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'MAPPING_IN_USE');
      throw e;
    }
    return { ok: true };
  });

  // Live check for one table: shows the manager exactly what diners will see.
  app.post('/api/admin/tables/:id/pos-sync', { preHandler: auth('staff') }, async (req) => {
    const { rows: [t] } = await pool.query(
      `SELECT t.id AS table_id, t.label, t.external_id, t.external_name, r.*
         FROM dining_tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.id = $1 AND t.restaurant_id = $2`,
      [req.params.id, rid(req)],
    );
    if (!t) throw new HttpError(404, 'NOT_FOUND');
    return syncTableBill(ctx, t, t, { force: true });
  });

  app.get('/api/admin/writebacks', { preHandler: auth('staff') }, async (req) => {
    const { rows } = await pool.query(
      `SELECT w.payment_id, w.mode, w.status, w.attempts, w.last_error, w.created_at, w.done_at,
              p.share_minor, p.tip_minor, p.currency, p.card_brand, p.card_last4, t.label AS table_label, b.external_ref
         FROM pos_writebacks w JOIN payments p ON p.id = w.payment_id JOIN bills b ON b.id = p.bill_id
         JOIN dining_tables t ON t.id = b.table_id
        WHERE w.restaurant_id = $1 AND (w.status <> 'done' OR w.done_at > now() - interval '1 day')
        ORDER BY (w.status = 'done'), w.created_at DESC LIMIT 200`, [rid(req)],
    );
    return { writebacks: rows };
  });

  app.post('/api/admin/writebacks/:id/done', { preHandler: auth('staff') }, async (req) => {
    const { rowCount } = await pool.query(
      `UPDATE pos_writebacks SET status = 'done', done_at = now(), done_by = $3, last_error = NULL
        WHERE payment_id = $1 AND restaurant_id = $2 AND status <> 'done'`,
      [req.params.id, rid(req), req.user.id],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: rid(req), action: 'pos.payment_marked_recorded', target: req.params.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/admin/writebacks/:id/retry', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query(
      `UPDATE pos_writebacks SET status = 'pending', attempts = 0, next_attempt_at = now()
        WHERE payment_id = $1 AND restaurant_id = $2 AND status = 'failed' AND mode = 'auto'`,
      [req.params.id, rid(req)],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });
}

/** OAuth redirect target. No session cookie arrives here (SameSite=Strict on a cross-site
 *  redirect), so the single-use `state` is what authenticates the request. */
export async function oauthCallbackRoutes(app, { ctx }) {
  app.get('/api/integrations/:provider/callback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const provider = req.params.provider;
    if (provider !== 'foodics') return reply.code(404).send({ error: 'NOT_FOUND' });
    try {
      await finishOAuth(ctx, { provider, code: req.query.code, state: req.query.state });
      return reply.redirect('/admin#integrations=connected', 303);
    } catch (e) {
      req.log.warn({ code: e.code }, 'oauth callback failed');
      const code = e instanceof PosError ? e.code : 'OAUTH_FAILED';
      return reply.redirect(`/admin#integrations=${encodeURIComponent(code)}`, 303);
    }
  });
}
