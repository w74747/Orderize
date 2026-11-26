// Integration tests against a real PostgreSQL (TEST_DATABASE_URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { hmacHex, totpAt } from '../src/lib/crypto.js';

const BASE = 'http://localhost:3999';
const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE,
  APP_SECRET: crypto.randomBytes(48).toString('base64'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
});
let pool, app, S;
let ipN = 1;
const ip = () => `10.0.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`; // fresh IP per test to avoid rate limits

before(async () => {
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  S = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  app = await buildApp({ config, pool, logger: false });
});
after(async () => { await app.close(); await pool.end(); });

const key = () => crypto.randomBytes(16).toString('hex');
const pay = (body, k = key(), token = S.demoToken, remoteAddress = ip()) =>
  app.inject({ method: 'POST', url: `/api/t/${token}/payments`, payload: body, headers: { 'idempotency-key': k }, remoteAddress });

async function resetBill() {
  S = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
}
async function captureViaSandbox(paymentId) {
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  const u = new URL(p.redirect_url);
  const res = await app.inject({
    method: 'POST', url: u.pathname, remoteAddress: ip(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ref: u.searchParams.get('ref'), sig: u.searchParams.get('sig'), card: '4242424242424242', action: 'pay' }).toString(),
  });
  return res;
}

test('security headers: CSP, no-referrer, no framing', async () => {
  const r = await app.inject({ url: `/t/${S.demoToken}` });
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('unknown / malformed table tokens return 404 without detail', async () => {
  for (const t of ['x', 'A'.repeat(24), "'; DROP TABLE bills;--aaaaaaaa"]) {
    const r = await app.inject({ url: `/api/t/${encodeURIComponent(t)}` });
    assert.equal(r.statusCode, 404);
  }
});

test('client cannot dictate the amount (unknown fields rejected)', async () => {
  const r = await pay({ split: { mode: 'full' }, amount_minor: 1 });
  assert.equal(r.statusCode, 400);
  const r2 = await pay({ split: { mode: 'full', amount_minor: 1 } });
  assert.equal(r2.statusCode, 400);
});

test('idempotency: same key+body returns same payment; same key+different body is rejected', async () => {
  await resetBill();
  const k = key();
  const a = await pay({ split: { mode: 'equal', parts: 4, pay: 1 } }, k);
  const b = await pay({ split: { mode: 'equal', parts: 4, pay: 1 } }, k);
  assert.equal(a.statusCode, 201);
  assert.equal(a.json().payment_id, b.json().payment_id);
  const c = await pay({ split: { mode: 'equal', parts: 4, pay: 2 } }, k);
  assert.equal(c.statusCode, 409);
});

test('concurrent full payments cannot over-pay a bill', async () => {
  await resetBill();
  const results = await Promise.all(Array.from({ length: 5 }, () => pay({ split: { mode: 'full' } })));
  const ok = results.filter((r) => r.statusCode === 201);
  assert.equal(ok.length, 1, 'exactly one diner can reserve the full amount');
  assert.ok(results.filter((r) => r.statusCode === 422).every((r) => r.json().error === 'BILL_ALREADY_PAID'));
});

test('full flow: payment captured via signed webhook closes the bill and emits a POS event', async () => {
  await resetBill();
  const r = await pay({ split: { mode: 'full' }, tip: { type: 'percent', value: 7 } });
  assert.equal(r.statusCode, 201);
  const res = await captureViaSandbox(r.json().payment_id);
  assert.equal(res.statusCode, 303);
  const st = (await app.inject({ url: `/api/payments/${r.json().payment_id}` })).json();
  assert.equal(st.status, 'captured');
  assert.equal(st.card_last4, '4242');
  const view = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  assert.equal(view.bill, null, 'bill is closed');
  const { rows } = await pool.query(`SELECT * FROM outbox WHERE type = 'payment.captured'`);
  assert.ok(rows.length >= 1);
});

test('webhooks: bad signature rejected; forged amount never marks paid; duplicates ignored', async () => {
  await resetBill();
  const r = await pay({ split: { mode: 'full' } });
  const id = r.json().payment_id;
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  const evt = { id: 'evt_1', payment_id: id, provider_ref: p.provider_ref, status: 'captured', amount_minor: 1, currency: 'AED', card: {} };
  const raw = JSON.stringify(evt);

  const bad = await app.inject({ method: 'POST', url: '/api/webhooks/sandbox', payload: raw,
    headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'deadbeef' } });
  assert.equal(bad.statusCode, 401);

  const sig = hmacHex(`sandbox-webhook:${config.APP_SECRET}`, raw);
  const mism = await app.inject({ method: 'POST', url: '/api/webhooks/sandbox', payload: raw,
    headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig } });
  assert.equal(mism.statusCode, 200);
  const after1 = (await pool.query('SELECT status, flag FROM payments WHERE id = $1', [id])).rows[0];
  assert.equal(after1.status, 'pending');
  assert.equal(after1.flag, 'amount_mismatch');

  const wrongProvider = await app.inject({ method: 'POST', url: '/api/webhooks/tap', payload: raw,
    headers: { 'content-type': 'application/json' } });
  assert.equal(wrongProvider.statusCode, 404);
});

test('bank offer requires a card from that bank (BIN enforced)', async () => {
  await resetBill();
  const view = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  const offer = view.offers.find((o) => o.bank_name === 'Desert Bank'); // BIN 411111, min spend 200
  const r = await pay({ split: { mode: 'full' }, offer_id: offer.id });
  assert.equal(r.statusCode, 201);
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [r.json().payment_id]);
  assert.equal(p.discount_minor, 5000);
  const u = new URL(p.redirect_url);
  const res = await app.inject({ method: 'POST', url: u.pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ ref: u.searchParams.get('ref'), sig: u.searchParams.get('sig'), card: '4242424242424242', action: 'pay' }).toString() });
  assert.match(res.body, /only valid with the participating bank card/);
  assert.equal((await pool.query('SELECT status FROM payments WHERE id = $1', [p.id])).rows[0].status, 'pending');
});

test('promo code min-spend and unknown codes', async () => {
  await resetBill();
  const q = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, payload: { split: { mode: 'full' }, promo_code: 'welcome10' } });
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().discount_minor, 2130);
  const bad = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, payload: { split: { mode: 'full' }, promo_code: 'NOPE123' } });
  assert.equal(bad.statusCode, 422);
});

// ---------- admin
const ORIGIN = { origin: BASE };
async function loginAs(email, password, extra = {}) {
  return app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email, password, ...extra }, remoteAddress: ip() });
}
const cookieOf = (r) => r.cookies.find((c) => c.name === 'sufra_sid');

test('admin: CSRF — state-changing requests need our Origin', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { email: 'a@b.co', password: 'x' } });
  assert.equal(r.statusCode, 403);
  const r2 = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: 'https://evil.example' }, payload: { email: 'a@b.co', password: 'x' } });
  assert.equal(r2.statusCode, 403);
});

test('admin: login, httpOnly SameSite=Strict cookie, generic errors, lockout', async () => {
  const ok = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  assert.equal(ok.statusCode, 200);
  const c = cookieOf(ok);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Strict');

  const unknown = await loginAs('nobody@x.example', 'whatever');
  const wrong = await loginAs('owner@sahab.example', 'nope');
  assert.deepEqual(unknown.json(), wrong.json(), 'no user enumeration');

  for (let i = 0; i < 5; i++) await loginAs('owner@sahab.example', 'nope');
  const locked = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  assert.equal(locked.statusCode, 401, 'account locked after repeated failures');
  await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL');
});

test('admin: tenant isolation — cannot touch another restaurant’s tables', async () => {
  const login = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  const cookie = { sufra_sid: cookieOf(login).value };
  const { rows: [other] } = await pool.query(
    `SELECT t.id FROM dining_tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.slug = 'qahwat-al-bahr' LIMIT 1`);
  const qr = await app.inject({ url: `/api/admin/tables/${other.id}/qr.svg`, cookies: cookie });
  assert.equal(qr.statusCode, 404);
  const rot = await app.inject({ method: 'POST', url: `/api/admin/tables/${other.id}/rotate`, cookies: cookie, headers: ORIGIN, payload: {} });
  assert.equal(rot.statusCode, 404);
  const mine = await app.inject({ url: '/api/admin/tables', cookies: cookie });
  assert.ok(mine.json().tables.every((t) => !t.label.startsWith('A')));
});

test('admin: TOTP 2FA enrol + required at login + replay blocked', async () => {
  const login = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  const cookie = { sufra_sid: cookieOf(login).value };
  const setup = await app.inject({ method: 'POST', url: '/api/admin/2fa/setup', cookies: cookie, headers: ORIGIN, payload: {} });
  const secret = setup.json().secret;
  const code = totpAt(secret, Math.floor(Date.now() / 30000));
  const en = await app.inject({ method: 'POST', url: '/api/admin/2fa/enable', cookies: cookie, headers: ORIGIN, payload: { code } });
  assert.equal(en.statusCode, 200);

  const noCode = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  assert.equal(noCode.json().error, 'TOTP_REQUIRED');
  const replay = await loginAs('owner@sahab.example', 'CorrectHorse2026', { totp: code });
  assert.equal(replay.statusCode, 401, 'same code cannot be reused');
  const next = totpAt(secret, Math.floor(Date.now() / 30000) + 1);
  const good = await loginAs('owner@sahab.example', 'CorrectHorse2026', { totp: next });
  assert.equal(good.statusCode, 200);
  await pool.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, failed_logins = 0');
});

// ---------- POS
test('POS API: signed requests open bills; replay, stale and forged requests are rejected', async () => {
  await resetBill();
  const login = await loginAs('owner@sahab.example', 'CorrectHorse2026');
  const cookie = { sufra_sid: cookieOf(login).value };
  const creds = (await app.inject({ method: 'POST', url: '/api/admin/pos-credentials', cookies: cookie, headers: ORIGIN, payload: {} })).json();
  const body = JSON.stringify({ table_label: 'S1 T2', external_ref: `pos-${key()}`, items: [{ name_en: 'Tea', name_ar: 'شاي', unit_price_minor: 1500, qty: 2 }] });
  const signed = (ts, nonce, secret = creds.pos_secret, url = '/api/pos/v1/bills', method = 'POST', raw = body) => ({
    'content-type': 'application/json', 'x-pos-key': creds.pos_key, 'x-pos-timestamp': String(ts), 'x-pos-nonce': nonce,
    'x-pos-signature': hmacHex(secret, `${ts}.${nonce}.${method}.${url}.${raw}`),
  });
  const now = Math.floor(Date.now() / 1000);
  const nonce = key();
  const ok = await app.inject({ method: 'POST', url: '/api/pos/v1/bills', payload: body, headers: signed(now, nonce) });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().total_minor, 3000, 'total computed server-side');

  const replay = await app.inject({ method: 'POST', url: '/api/pos/v1/bills', payload: body, headers: signed(now, nonce) });
  assert.equal(replay.json().error, 'REPLAYED_REQUEST');
  const stale = await app.inject({ method: 'POST', url: '/api/pos/v1/bills', payload: body, headers: signed(now - 3600, key()) });
  assert.equal(stale.json().error, 'STALE_REQUEST');
  const forged = await app.inject({ method: 'POST', url: '/api/pos/v1/bills', payload: body, headers: signed(now, key(), 'ps_wrong') });
  assert.equal(forged.statusCode, 401);

  const evNonce = key();
  const ev = await app.inject({ method: 'GET', url: '/api/pos/v1/events?after=0', headers: signed(now, evNonce, creds.pos_secret, '/api/pos/v1/events?after=0', 'GET', '') });
  assert.equal(ev.statusCode, 200);
});

test('audit log is append-only at the database level', async () => {
  await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
  await assert.rejects(pool.query(`UPDATE audit_log SET action = 'x'`), /append-only/);
});

test('errors never leak internals', async () => {
  const r = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/payments`, payload: '{bad json', headers: { 'content-type': 'application/json', 'idempotency-key': key() } });
  assert.equal(r.statusCode, 400);
  assert.doesNotMatch(r.body, /at |stack|SELECT|node_modules/);
});
