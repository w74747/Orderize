// Test-only WhatsApp link by QR: production guard, admin-only console API, OTP routing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { bootstrapPlatformAdmin } from '../src/routes/platform.js';
import { createWhatsApp } from '../src/lib/whatsapp.js';

const BASE = 'http://localhost:3998';
const ORIGIN = { origin: BASE };
const secret = crypto.randomBytes(48).toString('base64');
let pool, app, n = 1;
const ip = () => `10.30.0.${n++}`;
const env = (extra) => ({
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE, APP_SECRET: secret,
  COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
  PLATFORM_ADMIN_EMAIL: 'root@orderize.example', PLATFORM_ADMIN_PASSWORD: 'PlatformRoot2026!', PLATFORM_REQUIRE_2FA: 'false', ...extra,
});

before(async () => {
  const config = loadConfig(env({ WHATSAPP_WEB_ENABLED: 'true' }));
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  app = await buildApp({ config, pool, logger: false });
  await bootstrapPlatformAdmin(pool, config, { info() {} });
});
after(async () => { await app.close(); await pool.end(); });

async function login(email, password) {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email, password }, remoteAddress: ip() });
  assert.equal(r.statusCode, 200, r.body);
  return { orderize_sid: r.cookies.find((c) => c.name === 'orderize_sid').value };
}
const as = (cookies) => (method, url, payload) => app.inject({ method, url, cookies, headers: ORIGIN, remoteAddress: ip(), ...(payload !== undefined ? { payload } : {}) });

test('WHATSAPP_WEB_ENABLED is refused in real production', () => {
  const prod = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://x.example', COOKIE_SECURE: 'true', PAYMENT_PROVIDER: 'tap', TAP_SECRET_KEY: 'sk', TAP_WEBHOOK_SECRET: 'wh', WHATSAPP_WEB_ENABLED: 'true' };
  const prev = process.env.ALLOW_SANDBOX_IN_PRODUCTION;
  delete process.env.ALLOW_SANDBOX_IN_PRODUCTION;
  try { assert.throws(() => loadConfig(env(prod)), /WHATSAPP_WEB_ENABLED/); }
  finally { if (prev !== undefined) process.env.ALLOW_SANDBOX_IN_PRODUCTION = prev; }
});

test('console API is platform-admin only; unlinked number cannot send; diners get 503', async () => {
  const owner = as(await login('owner@sahab.example', 'CorrectHorse2026'));
  assert.equal((await owner('GET', '/api/platform/whatsapp')).statusCode, 403);
  assert.equal((await owner('POST', '/api/platform/whatsapp/connect', {})).statusCode, 403);

  const root = as(await login('root@orderize.example', 'PlatformRoot2026!'));
  const s = (await root('GET', '/api/platform/whatsapp')).json();
  assert.equal(s.enabled, true);
  assert.equal(s.state, 'disconnected');
  assert.equal(s.qr_svg, null);
  assert.equal((await root('POST', '/api/platform/whatsapp/test', { country: '968', phone: '91234567' })).statusCode, 502);

  const otp = await app.inject({ method: 'POST', url: '/api/me/otp', headers: ORIGIN, remoteAddress: ip(), payload: { country: '968', phone: '91234567' } });
  assert.equal(otp.statusCode, 503);
  assert.equal(otp.json().error, 'WHATSAPP_NOT_CONFIGURED');
});

test('a linked test number delivers OTPs as text and never sends coupons', async () => {
  const sent = [];
  const fake = { connected: true, async sendText(p, t) { sent.push([p, t]); } };
  const fakePool = { query: async () => ({ rows: [] }) };
  const wa = createWhatsApp(loadConfig(env({})), fakePool, { warn() {}, info() {} }, fake);
  assert.equal(wa.live, true);
  assert.deepEqual(await wa.sendOtp('+96891234567', '482913'), { sent: true });
  assert.equal(sent[0][0], '+96891234567');
  assert.match(sent[0][1], /482913/);
  assert.equal((await wa.sendCoupon('+96891234567', { restaurant: 'X', title: 'Y' })).sent, false);
  assert.equal(sent.length, 1);
  fake.connected = false;
  assert.equal(wa.live, false);
});
