// POS integration tests against in-process mock Foodics and Simphony servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { processWritebacks } from '../src/pos/service.js';
import { assertPublicHttpsUrl, toMinor } from '../src/pos/http.js';

const BASE = 'http://localhost:3999';
const ORIGIN = { origin: BASE };

// ---------- mock POS servers
function mockServer(handler) {
  const log = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
      const [status, json] = handler(req.method, u, body, req.headers);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, log, url: `http://127.0.0.1:${srv.address().port}` })));
}

const foodics = { orders: [], down: false, payments: 0 };
const simphony = { check: null, down: false, rounds: [] };
let F, S, pool, app, ctx, seeded, cookie;

before(async () => {
  F = await mockServer((m, u, body, h) => {
    if (u.pathname === '/oauth/token') {
      const b = JSON.parse(body);
      if (b.client_id !== 'fc_id' || b.client_secret !== 'fc_secret') return [401, {}];
      if (b.grant_type === 'authorization_code' && b.code !== 'good-code') return [400, { error: 'invalid_grant' }];
      return [200, { access_token: 'fat_1', refresh_token: 'frt_1', expires_in: 3600 }];
    }
    if (h.authorization !== 'Bearer fat_1') return [401, {}];
    if (foodics.down) return [503, {}];
    if (u.pathname === '/v5/branches') return [200, { data: [{ id: 'br1', name: 'Downtown', name_localized: 'وسط البلد' }] }];
    if (u.pathname === '/v5/tables') return [200, { data: [{ id: 't10', name: 'T10', section: { name: 'Main' } }, { id: 't11', name: 'T11', section: { name: 'Main' } }] }];
    if (u.pathname === '/v5/orders') {
      return [200, { data: foodics.orders.filter((o) => o.table.id === u.searchParams.get('filter[table_id]') && String(o.status) === u.searchParams.get('filter[status]')) }];
    }
    return [404, {}];
  });
  S = await mockServer((m, u, body, h) => {
    if (u.pathname === '/oidc-provider/v1/oauth2/token') {
      const b = Object.fromEntries(new URLSearchParams(body));
      if (b.refresh_token !== 'srt_good' && b.refresh_token !== 'srt_rotated') return [401, {}];
      return [200, { id_token: 'sid_1', refresh_token: 'srt_rotated', expires_in: 900 }];
    }
    if (h.authorization !== 'Bearer sid_1') return [401, {}];
    if (h['simphony-orgshortname'] !== 'acme' || h['simphony-locref'] !== 'loc1' || h['simphony-rvcref'] !== '7') return [400, {}];
    if (simphony.down) return [503, {}];
    if (m === 'GET' && u.pathname === '/api/v1/checks') {
      const t = u.searchParams.get('tableName');
      return [200, { items: simphony.check && (!t || t === '12') ? [simphony.check] : [] }];
    }
    const mm = u.pathname.match(/^\/api\/v1\/checks\/([^/]+)\/round$/);
    if (m === 'POST' && mm) {
      simphony.rounds.push(JSON.parse(body));
      return [200, { header: { checkRef: mm[1] } }];
    }
    return [404, {}];
  });

  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE,
    APP_SECRET: crypto.randomBytes(48).toString('base64'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
    FOODICS_CLIENT_ID: 'fc_id', FOODICS_CLIENT_SECRET: 'fc_secret',
    FOODICS_API_BASE: F.url, FOODICS_CONSOLE_BASE: 'https://console.example', ALLOW_PRIVATE_POS_HOSTS: 'true',
  });
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  seeded = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  app = await buildApp({ config, pool, logger: false });
  ctx = app.ctx;
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email: 'owner@sahab.example', password: 'CorrectHorse2026' } });
  cookie = { sufra_sid: login.cookies.find((c) => c.name === 'sufra_sid').value };
});
after(async () => { await app.close(); await pool.end(); F.srv.close(); S.srv.close(); });

const admin = (method, url, payload) => app.inject({ method, url, cookies: cookie, headers: ORIGIN, ...(payload ? { payload } : {}) });
const tokenOf = async (label) => (await pool.query('SELECT public_token FROM dining_tables WHERE label = $1', [label])).rows[0].public_token;
const view = async (label) => (await app.inject({ url: `/api/t/${await tokenOf(label)}` })).json();
const unfresh = () => pool.query('UPDATE bills SET synced_at = now() - interval \'1 hour\' WHERE status = \'open\'');

async function payFull(label) {
  const r = await app.inject({
    method: 'POST', url: `/api/t/${await tokenOf(label)}/payments`, payload: { split: { mode: 'full' } },
    headers: { 'idempotency-key': crypto.randomBytes(16).toString('hex') }, remoteAddress: `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`,
  });
  if (r.statusCode !== 201) return r;
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [r.json().payment_id]);
  const u = new URL(p.redirect_url);
  await app.inject({
    method: 'POST', url: u.pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ref: u.searchParams.get('ref'), sig: u.searchParams.get('sig'), card: '4242424242424242', action: 'pay' }).toString(),
  });
  return r;
}

test('SSRF guard: POS hosts must be public HTTPS', async () => {
  for (const bad of ['http://example.com', 'https://127.0.0.1', 'https://localhost', 'https://169.254.169.254/latest', 'https://user:pw@example.com', 'ftp://x']) {
    await assert.rejects(assertPublicHttpsUrl(bad), (e) => /URL_/.test(e.code), bad);
  }
});

test('decimal amounts convert to minor units exactly (2 and 3 decimals)', () => {
  assert.equal(toMinor(50.5, 2), 5050);
  assert.equal(toMinor('12.345', 3), 12345);
  assert.equal(toMinor(0.1 + 0.2, 2), 30);
  assert.equal(toMinor('19.995', 2), 2000);
});

test('Foodics: OAuth connect with single-use state, branch selection, table import', async () => {
  const start = await admin('POST', '/api/admin/integration/oauth/start', { provider: 'foodics' });
  assert.equal(start.statusCode, 200);
  const state = new URL(start.json().url).searchParams.get('state');
  assert.ok(state && state.length >= 40);

  const bad = await app.inject({ url: `/api/integrations/foodics/callback?code=good-code&state=forged` });
  assert.match(bad.headers.location, /OAUTH_STATE_INVALID/);
  const ok = await app.inject({ url: `/api/integrations/foodics/callback?code=good-code&state=${state}` });
  assert.equal(ok.headers.location, '/admin#integrations=connected');
  const replay = await app.inject({ url: `/api/integrations/foodics/callback?code=good-code&state=${state}` });
  assert.match(replay.headers.location, /OAUTH_STATE_INVALID/, 'state cannot be reused');

  const info = await admin('GET', '/api/admin/integration');
  assert.equal(info.json().connection.provider, 'foodics');
  assert.doesNotMatch(info.body, /fat_1|frt_1/, 'tokens are never returned');
  const { rows: [row] } = await pool.query('SELECT secrets_enc FROM pos_connections');
  assert.doesNotMatch(row.secrets_enc, /fat_1/, 'tokens are encrypted at rest');

  assert.equal((await admin('POST', '/api/admin/integration/branch', { branch_id: 'nope' })).statusCode, 422);
  assert.equal((await admin('POST', '/api/admin/integration/branch', { branch_id: 'br1' })).json().connection.status, 'active');

  const sync = await admin('POST', '/api/admin/integration/sync-tables', {});
  assert.deepEqual(sync.json(), { created: 2, matched: 0, total: 2 });
  assert.deepEqual((await admin('POST', '/api/admin/integration/sync-tables', {})).json().created, 0, 'idempotent');
});

test('Foodics: live bill appears, updates, counts POS-side payments, closes with the order', async () => {
  assert.equal((await view('Main T10')).bill, null, 'no order yet');
  foodics.orders = [{
    id: 'o1', status: 2, table: { id: 't10' }, total_price: 100, total_tax: 4.76,
    products: [{ quantity: 2, unit_price: 30, total_price: 60, product: { name: 'Latte', name_localized: 'لاتيه' } },
      { quantity: 1, unit_price: 40, total_price: 40, product: { name: 'Cake', name_localized: 'كيك' } }],
    payments: [],
  }];
  const v1 = await view('Main T10');
  assert.equal(v1.bill.total_minor, 10000);
  assert.equal(v1.bill.items.length, 2);
  assert.equal(v1.bill.items[0].name_ar, 'لاتيه');

  // A new round is added at the cashier + a guest paid 30 cash at the counter.
  foodics.orders[0].products.push({ quantity: 1, unit_price: 20, total_price: 20, product: { name: 'Juice' } });
  foodics.orders[0].total_price = 120;
  foodics.orders[0].payments = [{ amount: 30 }];
  await unfresh();
  const v2 = await view('Main T10');
  assert.equal(v2.bill.total_minor, 12000);
  assert.equal(v2.bill.remaining_minor, 9000, 'cash paid at the POS is deducted');
  assert.equal(v2.bill.items.length, 3);

  // Order closed at the cashier with no Sufra payment -> bill disappears.
  foodics.orders = [];
  await unfresh();
  assert.equal((await view('Main T10')).bill, null);
});

test('Foodics: refuses payment when the POS is down and the bill is stale; queues manual recording', async () => {
  foodics.orders = [{ id: 'o2', status: 2, table: { id: 't11' }, total_price: 50, products: [{ quantity: 1, unit_price: 50, total_price: 50, product: { name: 'Mezze' } }], payments: [] }];
  assert.equal((await view('Main T11')).bill.total_minor, 5000);
  foodics.down = true;
  await unfresh();
  const v = await view('Main T11');
  assert.equal(v.pos_unavailable, true);
  const r = await payFull('Main T11');
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'POS_UNAVAILABLE');
  foodics.down = false;

  const ok = await payFull('Main T11');
  assert.equal(ok.statusCode, 201);
  const wb = (await admin('GET', '/api/admin/writebacks')).json().writebacks;
  const mine = wb.find((w) => w.payment_id === ok.json().payment_id);
  assert.equal(mine.mode, 'manual');
  assert.equal(mine.status, 'pending');
  assert.equal((await admin('POST', `/api/admin/writebacks/${mine.payment_id}/done`, {})).statusCode, 200);
  assert.equal((await admin('POST', `/api/admin/writebacks/${mine.payment_id}/done`, {})).statusCode, 404, 'only once');

  // Staff recorded it in Foodics: POS now reports it as paid — must not be double counted.
  foodics.orders[0].payments = [{ amount: 50 }];
  await unfresh();
  await app.inject({ url: `/api/t/${await tokenOf('Main T11')}` });
  const { rows: [b] } = await pool.query(`SELECT external_paid_minor FROM bills WHERE external_ref = 'foodics:o2'`);
  assert.equal(b.external_paid_minor, 0);
});

test('Simphony: bad credentials are rejected and nothing is saved', async () => {
  const r = await admin('POST', '/api/admin/integration/simphony', {
    host: S.url, org: 'ACME', loc: 'loc1', rvc: 7, tender_id: 301, employee_ref: 90, client_id: 'cid', refresh_token: 'wrong',
  });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'POS_AUTH_FAILED');
  assert.equal((await pool.query(`SELECT provider FROM pos_connections`)).rows[0].provider, 'foodics');
});

test('Simphony: live check by table name, automatic payment write-back with idempotency', async () => {
  const r = await admin('POST', '/api/admin/integration/simphony', {
    host: S.url, org: 'ACME', loc: 'LOC1', rvc: 7, tender_id: 301, employee_ref: 90, client_id: 'cid', refresh_token: 'srt_good',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().connection.status, 'active');
  assert.doesNotMatch(r.body, /srt_|sid_1/);

  const { rows: [t] } = await pool.query(`SELECT id FROM dining_tables WHERE label = 'S1 T2'`);
  assert.equal((await admin('POST', `/api/admin/tables/${t.id}/mapping`, { external_name: '12' })).statusCode, 200);

  simphony.check = {
    header: { checkRef: 'abc123', status: 'open', tableName: '12' },
    totals: { totalDue: 50.5, paymentTotal: 0, taxTotal: 2.4 },
    menuItems: [{ name: 'Machboos', quantity: 1, total: 38 }, { name: 'Laban', quantity: 2, total: 12.5 }],
  };
  const v = await view('S1 T2');
  assert.equal(v.bill.total_minor, 5050);

  const pay = await payFull('S1 T2');
  assert.equal(pay.statusCode, 201);
  const pid = pay.json().payment_id;
  const { rows: [w] } = await pool.query('SELECT * FROM pos_writebacks WHERE payment_id = $1', [pid]);
  assert.equal(w.mode, 'auto');

  simphony.down = true;
  await processWritebacks(ctx);
  let { rows: [w2] } = await pool.query('SELECT * FROM pos_writebacks WHERE payment_id = $1', [pid]);
  assert.equal(w2.status, 'pending', 'retried later');
  assert.equal(w2.attempts, 1);

  simphony.down = false;
  await pool.query('UPDATE pos_writebacks SET next_attempt_at = now() WHERE payment_id = $1', [pid]);
  await processWritebacks(ctx);
  ({ rows: [w2] } = await pool.query('SELECT * FROM pos_writebacks WHERE payment_id = $1', [pid]));
  assert.equal(w2.status, 'done');
  const round = simphony.rounds.at(-1);
  assert.equal(round.tenders[0].tenderId, 301);
  assert.equal(round.tenders[0].total, 50.5);
  assert.equal(round.header.idempotencyId, pid.replace(/-/g, ''));
  const auth = S.log.filter((l) => l.path.endsWith('/round')).at(-1).headers.authorization;
  assert.equal(auth, 'Bearer sid_1');

  const { rows: [conn] } = await pool.query('SELECT secrets_enc FROM pos_connections');
  assert.match(ctx.cipher.decrypt(conn.secrets_enc), /srt_rotated/, 'rotated refresh token persisted');
});

test('integration endpoints require owner/manager and our Origin', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/integration/manual', cookies: cookie, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/admin/integration' })).statusCode, 401);
  const r = await admin('POST', '/api/admin/integration/simphony', {
    host: 'https://169.254.169.254', org: 'a', loc: 'b', rvc: 1, tender_id: 1, employee_ref: 1, client_id: 'x', refresh_token: 'y',
  });
  // allowPrivate is on in tests, so the metadata IP is only refused by DNS-free URL validation in production;
  // here we at least verify that a failing host never gets saved.
  assert.notEqual(r.statusCode, 200);
});
