// Diner accounts (WhatsApp OTP), loyalty, coupons, ratings, CRM and platform console.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { bootstrapPlatformAdmin } from '../src/routes/platform.js';
import { runBirthdayCampaigns } from '../src/services/campaigns.js';
import { normalizePhone } from '../src/lib/phone.js';

const BASE = 'http://localhost:3999';
const ORIGIN = { origin: BASE };
let pool, app, S, owner;
let ipN = 1;
const ip = () => `10.20.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

before(async () => {
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE,
    APP_SECRET: crypto.randomBytes(48).toString('base64'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
    OTP_DEV_ECHO: 'true', PLATFORM_ADMIN_EMAIL: 'root@sufra.example', PLATFORM_ADMIN_PASSWORD: 'PlatformRoot2026!', PLATFORM_REQUIRE_2FA: 'false',
  });
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  S = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  app = await buildApp({ config, pool, logger: false });
  await bootstrapPlatformAdmin(pool, config, { info() {} });
  owner = await login('owner@sahab.example', 'CorrectHorse2026');
});
after(async () => { await app.close(); await pool.end(); });

async function login(email, password) {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email, password }, remoteAddress: ip() });
  assert.equal(r.statusCode, 200, r.body);
  return { sufra_sid: r.cookies.find((c) => c.name === 'sufra_sid').value };
}
const as = (cookies) => (method, url, payload) => app.inject({ method, url, cookies, headers: ORIGIN, remoteAddress: ip(), ...(payload !== undefined ? { payload } : {}) });

async function signIn(local, { country = '971', profile } = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/me/otp', headers: ORIGIN, payload: { country, phone: local }, remoteAddress: ip() });
  assert.equal(r.statusCode, 200, r.body);
  const { challenge_id, dev_code } = r.json();
  const v = await app.inject({ method: 'POST', url: '/api/me/otp/verify', headers: ORIGIN, payload: { challenge_id, code: dev_code }, remoteAddress: ip() });
  assert.equal(v.statusCode, 200, v.body);
  const cookies = { sufra_diner: v.cookies.find((c) => c.name === 'sufra_diner').value };
  if (profile) assert.equal((await as(cookies)('PUT', '/api/me/profile', profile)).statusCode, 200);
  return { cookies, needs_profile: v.json().needs_profile };
}

const fresh = () => seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });

async function pay(diner, token, extra = {}) {
  const r = await app.inject({
    method: 'POST', url: `/api/t/${token}/payments`, cookies: diner.cookies, headers: { ...ORIGIN, 'idempotency-key': crypto.randomBytes(16).toString('hex') },
    payload: { split: { mode: 'full' }, ...extra }, remoteAddress: ip(),
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

test('phone numbers: strict GCC validation', () => {
  assert.equal(normalizePhone('971', '050 123 4567'), '+971501234567');
  assert.equal(normalizePhone('+968', '9123 4567'), '+96891234567');
  assert.equal(normalizePhone('966', '+966 55 123 4567'), '+966551234567');
  assert.equal(normalizePhone('971', '041234567'), null, 'landline rejected');
  assert.equal(normalizePhone('968', '1234'), null);
});

test('OTP: wrong codes burn attempts, expires after 5, resend throttled, code is single-use', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/me/otp', headers: ORIGIN, payload: { country: '971', phone: '501110001' }, remoteAddress: ip() });
  const { challenge_id, dev_code } = r.json();
  const again = await app.inject({ method: 'POST', url: '/api/me/otp', headers: ORIGIN, payload: { country: '971', phone: '501110001' }, remoteAddress: ip() });
  assert.equal(again.json().error, 'OTP_WAIT');
  const wrong = dev_code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const v = await app.inject({ method: 'POST', url: '/api/me/otp/verify', headers: ORIGIN, payload: { challenge_id, code: wrong }, remoteAddress: ip() });
    assert.equal(v.json().error, 'INVALID_CODE');
  }
  const late = await app.inject({ method: 'POST', url: '/api/me/otp/verify', headers: ORIGIN, payload: { challenge_id, code: dev_code }, remoteAddress: ip() });
  assert.equal(late.json().error, 'CODE_EXPIRED', 'locked after 5 attempts, even with the right code');
  const { rows: [ch] } = await pool.query('SELECT code_hash FROM otp_challenges WHERE id = $1', [challenge_id]);
  assert.notEqual(ch.code_hash, dev_code, 'code stored hashed');
  const noOrigin = await app.inject({ method: 'POST', url: '/api/me/otp', payload: { country: '971', phone: '501110002' } });
  assert.equal(noOrigin.statusCode, 403);
});

test('sign-in required to pay; first-time diners complete a profile; recognised at every restaurant', async () => {
  await pool.query('UPDATE restaurants SET require_phone = true');
  const anon = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/payments`, headers: { 'idempotency-key': crypto.randomBytes(16).toString('hex') }, payload: { split: { mode: 'full' } } });
  assert.equal(anon.json().error, 'SIGN_IN_REQUIRED');

  const d = await signIn('501230001');
  assert.equal(d.needs_profile, true);
  const young = await as(d.cookies)('PUT', '/api/me/profile', { name: 'Kid', gender: 'male', birth_date: new Date(Date.now() - 5 * 365 * 864e5).toISOString().slice(0, 10) });
  assert.equal(young.statusCode, 400);
  assert.equal((await as(d.cookies)('PUT', '/api/me/profile', { name: 'Sara', gender: 'female', birth_date: '1994-03-12', marketing_consent: true })).statusCode, 200);

  await pool.query(`UPDATE otp_challenges SET created_at = now() - interval '1 minute'`); // past the resend cooldown
  const again = await signIn('0501230001'); // same number typed differently
  assert.equal(again.needs_profile, false);
  const other = (await app.inject({ url: `/api/t/${S.omrToken}`, cookies: again.cookies })).json();
  assert.equal(other.me.name, 'Sara', 'same diner recognised at another restaurant');
});

test('payment earns points; account shows orders and balances across restaurants', async () => {
  await fresh();
  const d = await signIn('501230002', { profile: { name: 'Omar', gender: 'male', birth_date: '1990-01-01' } });
  assert.equal((await pay(d, S.demoToken)).statusCode, 201);
  const me = (await as(d.cookies)('GET', '/api/me')).json();
  assert.equal(me.orders.length, 1);
  assert.equal(me.points[0].points, 213, '1 point per AED on 213.00');
  assert.equal(me.orders[0].points, 213);
});

test('campaign coupons: targeted, owned by the diner, single use; free-item coupons need the item', async () => {
  await fresh();
  const a = await signIn('501230003', { profile: { name: 'Aisha', gender: 'female', birth_date: '1995-05-05' } });
  const b = await signIn('501230004', { profile: { name: 'Bader', gender: 'male', birth_date: '1985-05-05' } });
  await pay(a, S.demoToken);
  await fresh();

  const admin = as(owner);
  const c1 = await admin('POST', '/api/admin/campaigns', { name: '10% back', kind: 'percent', value: 10, audience: 'all', valid_days: 7 });
  assert.ok(c1.json().issued >= 1);
  const bView = (await app.inject({ url: `/api/t/${S.demoToken}`, cookies: b.cookies })).json();
  assert.equal(bView.me.coupons.length, 0, 'only diners who visited this restaurant');
  const view = (await app.inject({ url: `/api/t/${S.demoToken}`, cookies: a.cookies })).json();
  const coupon = view.me.coupons[0];
  assert.equal(coupon.kind, 'percent');

  const stolen = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: b.cookies, payload: { split: { mode: 'full' }, coupon_id: coupon.id } });
  assert.equal(stolen.json().error, 'COUPON_INVALID', "another diner can't use it");
  const q = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: a.cookies, payload: { split: { mode: 'full' }, coupon_id: coupon.id } });
  assert.equal(q.json().discount_minor, 2130);
  const both = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: a.cookies, payload: { split: { mode: 'full' }, coupon_id: coupon.id, promo_code: 'WELCOME10' } });
  assert.equal(both.json().error, 'ONE_OFFER_ONLY');

  assert.equal((await pay(a, S.demoToken, { coupon_id: coupon.id })).statusCode, 201);
  await fresh();
  const reuse = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: a.cookies, payload: { split: { mode: 'full' }, coupon_id: coupon.id } });
  assert.equal(reuse.json().error, 'COUPON_INVALID');

  // Visits count distinct days: move Aisha's first visit to two days ago.
  await pool.query(`UPDATE payments SET captured_at = now() - interval '2 days' WHERE id = (SELECT min(p.id::text)::uuid FROM payments p JOIN customers c ON c.id = p.customer_id WHERE c.name = 'Aisha' AND p.coupon_id IS NULL)`);
  const free = await admin('POST', '/api/admin/campaigns', { name: 'Free latte', kind: 'free_item', item_name: 'Spanish Latte Hot', value: 5000, audience: 'frequent', audience_param: 2 });
  assert.ok(free.json().issued >= 1);
  const fc = (await app.inject({ url: `/api/t/${S.demoToken}`, cookies: a.cookies })).json().me.coupons.find((k) => k.kind === 'free_item');
  const fq = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: a.cookies, payload: { split: { mode: 'full' }, coupon_id: fc.id } });
  assert.equal(fq.json().discount_minor, 3200, 'one latte free');
  await pool.query(`UPDATE campaigns SET item_name = 'Lobster' WHERE id = $1`, [free.json().campaign.id]);
  const miss = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/quote`, cookies: a.cookies, payload: { split: { mode: 'full' }, coupon_id: fc.id } });
  assert.equal(miss.json().error, 'COUPON_ITEM_NOT_ON_BILL');
});

test('birthday coupons are issued automatically, once a year', async () => {
  await fresh();
  const today = new Date();
  const bd = `1992-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  const d = await signIn('501230005', { profile: { name: 'Huda', gender: 'female', birth_date: bd } });
  await pay(d, S.demoToken);
  await as(owner)('POST', '/api/admin/campaigns', { name: 'Happy birthday', kind: 'fixed', value: 2500, audience: 'birthday', audience_param: 3, valid_days: 10 });
  const ctx = app.ctx;
  await runBirthdayCampaigns(ctx);
  await runBirthdayCampaigns(ctx);
  const { rows } = await pool.query(`SELECT k.* FROM coupons k JOIN campaigns c ON c.id = k.campaign_id WHERE c.audience = 'birthday' AND k.customer_id = (SELECT id FROM customers WHERE name = 'Huda')`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].issue_key, /^bday-\d{4}$/);
});

test('rating: once per payment, only by its diner, Google link shown whatever the stars', async () => {
  await fresh();
  await as(owner)('PUT', '/api/admin/settings', { google_review_url: 'https://g.page/r/sahab/review' });
  const d = await signIn('501230006', { profile: { name: 'Faisal', gender: 'male', birth_date: '1988-08-08' } });
  const other = await signIn('501230007', { profile: { name: 'Mona', gender: 'female', birth_date: '1991-01-01' } });
  const p = (await pay(d, S.demoToken)).json().payment_id;
  const forged = await as(other.cookies)('POST', `/api/payments/${p}/rating`, { stars: 1 });
  assert.equal(forged.statusCode, 403);
  const r = await as(d.cookies)('POST', `/api/payments/${p}/rating`, { stars: 2, comment: 'Slow service' });
  assert.equal(r.json().google_review_url, 'https://g.page/r/sahab/review', 'not gated on stars');
  assert.equal((await as(d.cookies)('POST', `/api/payments/${p}/rating`, { stars: 5 })).statusCode, 409);
  const list = (await as(owner)('GET', '/api/admin/ratings')).json().ratings;
  assert.equal(list[0].comment, 'Slow service');
});

test('restaurant CRM: counts, frequency and masked phones', async () => {
  const s = (await as(owner)('GET', '/api/admin/customers')).json();
  assert.ok(s.kpi.customers >= 4);
  assert.ok(s.buckets.length >= 1);
  assert.ok(s.top.every((c) => /•••/.test(c.phone) && !('phone_e164' in c)), 'phones masked');
});

test('platform console: only the platform admin; creates restaurants, suspends, manages bank offers', async () => {
  assert.equal((await as(owner)('GET', '/api/platform/overview')).statusCode, 403);
  const root = as(await login('root@sufra.example', 'PlatformRoot2026!'));
  assert.equal((await root('GET', '/api/platform/overview')).statusCode, 200);

  const plan = (await root('POST', '/api/platform/plans', { name: 'Pro', price_minor: 49900, currency: 'OMR', interval: 'month' })).json();
  const created = await root('POST', '/api/platform/restaurants', {
    slug: 'luban-house', name_en: 'Luban House', name_ar: 'بيت اللبان', country: 'OM', currency: 'OMR', owner_email: 'owner@luban.example', plan_id: plan.id,
  });
  assert.equal(created.statusCode, 201);
  assert.ok(created.json().temporary_password.length >= 16);
  const luban = as(await login('owner@luban.example', created.json().temporary_password));
  assert.equal((await luban('GET', '/api/admin/summary')).statusCode, 200);
  assert.equal((await root('POST', '/api/platform/restaurants', { slug: 'luban-house', name_en: 'x', name_ar: 'x', country: 'OM', currency: 'OMR', owner_email: 'a@b.example' })).statusCode, 409);

  // Suspending a restaurant disables its QR codes and signs its staff out.
  const { rows: [sahab] } = await pool.query(`SELECT id FROM restaurants WHERE slug = 'sahab-cafe'`);
  await root('PUT', `/api/platform/restaurants/${sahab.id}/subscription`, { status: 'suspended' });
  assert.equal((await app.inject({ url: `/api/t/${S.demoToken}` })).statusCode, 404);
  assert.equal((await as(owner)('GET', '/api/admin/summary')).statusCode, 401);
  await root('PUT', `/api/platform/restaurants/${sahab.id}/subscription`, { status: 'active', current_period_end: '2027-01-01' });
  owner = await login('owner@sahab.example', 'CorrectHorse2026');

  const inv = (await root('POST', `/api/platform/restaurants/${sahab.id}/invoices`, { amount_minor: 49900, period_start: '2027-01-01', period_end: '2027-01-31' })).json();
  assert.equal((await root('POST', `/api/platform/invoices/${inv.id}/paid`, { reference: 'TRX-1' })).statusCode, 200);
  const { rows: [sub] } = await pool.query('SELECT current_period_end FROM subscriptions WHERE restaurant_id = $1', [sahab.id]);
  assert.equal(sub.current_period_end, '2027-01-31');

  const bad = await root('POST', '/api/platform/bank-offers', { bank_name: 'X', title_en: 'x', title_ar: 'x', kind: 'percent', value: 150, currency: 'AED', bin_prefixes: ['411111'] });
  assert.equal(bad.statusCode, 400);
  const o = await root('POST', '/api/platform/bank-offers', {
    bank_name: 'Coastal Sample Bank', title_en: '15% off', title_ar: 'خصم 15٪', kind: 'percent', value: 15, max_minor: 3000, currency: 'AED', bin_prefixes: ['520000'], theme: 'green',
  });
  assert.equal(o.statusCode, 201);
  const pub = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  assert.ok(pub.offers.some((x) => x.bank_name === 'Coastal Sample Bank'));
  assert.ok(!JSON.stringify(pub).includes('520000'), 'BIN ranges are not exposed publicly');
});

test('account deletion erases personal data and ends the session', async () => {
  const d = await signIn('501230099', { profile: { name: 'Temp', gender: 'male', birth_date: '1999-09-09' } });
  assert.equal((await as(d.cookies)('DELETE', '/api/me')).statusCode, 200);
  assert.equal((await as(d.cookies)('GET', '/api/me')).statusCode, 401);
  const { rows } = await pool.query(`SELECT * FROM customers WHERE phone_e164 = '+971501230099'`);
  assert.equal(rows.length, 0);
});
