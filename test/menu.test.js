// Restaurant menu management and menu file uploads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { hashPassword } from '../src/lib/crypto.js';

const BASE = 'http://localhost:3999';
const ORIGIN = { origin: BASE };
let pool, app, S, owner, staff;
let ipN = 1;
const ip = () => `10.30.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n'), crypto.randomBytes(200), Buffer.from('\n%%EOF')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(100)]);

async function login(email, password) {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email, password }, remoteAddress: ip() });
  assert.equal(r.statusCode, 200, r.body);
  return { orderize_sid: r.cookies.find((c) => c.name === 'orderize_sid').value };
}
const as = (cookies) => (method, url, payload, headers = {}) =>
  app.inject({ method, url, cookies, headers: { ...ORIGIN, ...headers }, remoteAddress: ip(), ...(payload !== undefined ? { payload } : {}) });
const up = (who, buf, type) => as(who)('PUT', '/api/admin/menu/files', buf, { 'content-type': type });

before(async () => {
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE,
    APP_SECRET: crypto.randomBytes(48).toString('base64'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
  });
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  S = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  await pool.query(
    `INSERT INTO users(restaurant_id, email, password_hash, role) VALUES ($1,'staff@sahab.example',$2,'staff')`,
    [S.restaurantId, await hashPassword('StaffPassword2026')],
  );
  app = await buildApp({ config, pool, logger: false });
  owner = await login('owner@sahab.example', 'CorrectHorse2026');
  staff = await login('staff@sahab.example', 'StaffPassword2026');
});
after(async () => { await app.close(); await pool.end(); });

test('seeded menu is served to diners from the managed tables', async () => {
  const v = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  assert.equal(v.restaurant.menu.categories.length, 2);
  assert.equal(v.restaurant.menu.pdf, null);
});

test('managers edit the menu; staff can only toggle availability', async () => {
  const m = (await as(owner)('GET', '/api/admin/menu')).json();
  const cat = m.categories[0];
  const denied = await as(staff)('POST', '/api/admin/menu/items', { category_id: cat.id, name_en: 'X', name_ar: 'X', price_minor: 100 });
  assert.equal(denied.statusCode, 403);
  const ok = await as(owner)('POST', '/api/admin/menu/items', { category_id: cat.id, name_en: 'Halloumi Wrap', name_ar: 'راب حلوم', price_minor: 3800, description_en: 'Grilled halloumi, za\'atar' });
  assert.equal(ok.statusCode, 201);
  assert.equal((await as(staff)('POST', `/api/admin/menu/items/${ok.json().id}/availability`, { available: false })).statusCode, 200);
  const v = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  assert.ok(!JSON.stringify(v.restaurant.menu).includes('Halloumi'), 'sold-out items are hidden from diners');
});

test('items cannot be attached to another restaurant\'s category', async () => {
  const { rows: [other] } = await pool.query(`SELECT id FROM restaurants WHERE slug = 'qahwat-al-bahr'`);
  const { rows: [c] } = await pool.query(`INSERT INTO menu_categories(restaurant_id, name_en, name_ar) VALUES ($1,'Other','أخرى') RETURNING id`, [other.id]);
  const r = await as(owner)('POST', '/api/admin/menu/items', { category_id: c.id, name_en: 'Hack', name_ar: 'x', price_minor: 1 });
  assert.equal(r.statusCode, 404);
  assert.equal((await as(owner)('DELETE', `/api/admin/menu/categories/${c.id}`)).statusCode, 404);
});

test('bulk import from spreadsheet rows', async () => {
  const r = await as(owner)('POST', '/api/admin/menu/import', {
    replace: true,
    rows: [
      { category_en: 'Mains', category_ar: 'الأطباق الرئيسية', name_en: 'Machboos', name_ar: 'مجبوس', price_minor: 6500 },
      { category_en: 'Mains', name_en: 'Shuwa', price_minor: 7200 },
      { category_en: 'Sweets', name_en: 'Halwa', name_ar: 'حلوى', price_minor: 2200 },
    ],
  });
  assert.deepEqual(r.json(), { created: 3, categories: 2 });
  const m = (await as(owner)('GET', '/api/admin/menu')).json();
  assert.deepEqual(m.categories.map((c) => c.name_en), ['Mains', 'Sweets']);
  assert.equal(m.categories[0].items[1].name_ar, 'Shuwa', 'Arabic name falls back to English');
});

test('uploads: real PDF/images only; type is checked by content, not by the header', async () => {
  assert.equal((await up(owner, PDF, 'application/pdf')).statusCode, 201);
  const fakePdf = await up(owner, Buffer.from('<html><script>alert(1)</script></html>'), 'application/pdf');
  assert.equal(fakePdf.statusCode, 415);
  assert.equal((await up(owner, PNG, 'image/jpeg')).statusCode, 415, 'PNG declared as JPEG is refused');
  assert.equal((await up(owner, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).statusCode, 415);
  assert.equal((await up(staff, JPG, 'image/jpeg')).statusCode, 403);
  const big = Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await up(owner, big, 'image/jpeg')).statusCode, 413);
  const noOrigin = await app.inject({ method: 'PUT', url: '/api/admin/menu/files', cookies: owner, headers: { 'content-type': 'image/jpeg' }, payload: JPG });
  assert.equal(noOrigin.statusCode, 403);
  const textBody = await as(owner)('POST', '/api/admin/menu/categories', 'name_en=x', { 'content-type': 'text/plain' });
  assert.equal(textBody.statusCode, 415, 'other routes stay JSON-only');
});

test('a new PDF replaces the old one; images are capped at 20', async () => {
  const second = await up(owner, PDF, 'application/pdf');
  const { rows } = await pool.query(`SELECT id FROM media WHERE kind = 'menu_pdf'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, second.json().id);
  for (let i = 0; i < 20; i++) assert.equal((await up(owner, i % 2 ? PNG : JPG, i % 2 ? 'image/png' : 'image/jpeg')).statusCode, 201);
  assert.equal((await up(owner, JPG, 'image/jpeg')).json().error, 'TOO_MANY_IMAGES');
});

test('menu files are served safely and only for active restaurants', async () => {
  const v = (await app.inject({ url: `/api/t/${S.demoToken}` })).json();
  assert.ok(v.restaurant.menu.pdf);
  assert.equal(v.restaurant.menu.images.length, 20);
  const pdf = await app.inject({ url: `/media/${v.restaurant.menu.pdf}` });
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['x-content-type-options'], 'nosniff');
  assert.ok(pdf.rawPayload.subarray(0, 5).toString() === '%PDF-');
  const img = await app.inject({ url: `/media/${v.restaurant.menu.images[0]}` });
  assert.match(img.headers['content-security-policy'], /sandbox/);
  assert.equal((await app.inject({ url: '/media/not-a-uuid' })).statusCode, 404);

  await pool.query(`UPDATE restaurants SET active = false WHERE id = $1`, [S.restaurantId]);
  assert.equal((await app.inject({ url: `/media/${v.restaurant.menu.pdf}` })).statusCode, 404);
  await pool.query(`UPDATE restaurants SET active = true WHERE id = $1`, [S.restaurantId]);
});
