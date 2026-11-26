// Interactive menu editor, banners, table ordering, order stations and waiter calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server.js';
import { seed } from '../scripts/seed.js';
import { hashPassword } from '../src/lib/crypto.js';

const BASE = 'http://localhost:3997';
const ORIGIN = { origin: BASE };
let pool, app, S, owner, staff;
let n = 1;
const ip = () => `10.40.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const key = () => crypto.randomBytes(16).toString('base64url');
const JPG = await sharp({ create: { width: 1400, height: 1000, channels: 3, background: '#3a7' } }).jpeg().toBuffer();

async function login(email, password) {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: ORIGIN, payload: { email, password }, remoteAddress: ip() });
  assert.equal(r.statusCode, 200, r.body);
  return { orderize_sid: r.cookies.find((c) => c.name === 'orderize_sid').value };
}
const as = (cookies) => (method, url, payload, headers = {}) =>
  app.inject({ method, url, cookies, headers: { ...ORIGIN, ...headers }, remoteAddress: ip(), ...(payload !== undefined ? { payload } : {}) });
const diner = (method, url, payload) => app.inject({ method, url, headers: ORIGIN, remoteAddress: ip(), ...(payload !== undefined ? { payload } : {}) });
const view = async () => (await app.inject({ url: `/api/t/${S.demoToken}` })).json();

before(async () => {
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, PUBLIC_BASE_URL: BASE,
    APP_SECRET: crypto.randomBytes(48).toString('base64'), COOKIE_SECURE: 'false', TRUST_PROXY: 'false', LOG_LEVEL: 'silent',
  });
  pool = createPool(config.DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  S = await seed(pool, { ownerPassword: 'CorrectHorse2026', quiet: true });
  await pool.query(`INSERT INTO users(restaurant_id, email, password_hash, role) VALUES ($1,'staff@sahab.example',$2,'staff')`,
    [S.restaurantId, await hashPassword('StaffPassword2026')]);
  app = await buildApp({ config, pool, logger: false });
  // Deterministic fake translator (no network in tests).
  app.ctx.translator = {
    enabled: true,
    async translate(_p, _r, texts, from, to) { return texts.map((t) => `[${from}>${to}] ${t}`); },
  };
  owner = await login('owner@sahab.example', 'CorrectHorse2026');
  staff = await login('staff@sahab.example', 'StaffPassword2026');
  // The seeded table has an open bill from the seed; close it so ordering starts a fresh one.
  await pool.query(`UPDATE bills SET status = 'void', closed_at = now() WHERE restaurant_id = $1 AND status = 'open'`, [S.restaurantId]);
});
after(async () => { await app.close(); await pool.end(); });

let item;
test('item editor: images are re-encoded, missing language is auto-translated, options get ids', async () => {
  const up = await as(owner)('PUT', '/api/admin/media/item', JPG, { 'content-type': 'image/jpeg' });
  assert.equal(up.statusCode, 201, up.body);
  const pic = await app.inject({ url: up.json().url });
  assert.equal(pic.headers['content-type'], 'image/webp');
  const meta = await sharp(pic.rawPayload).metadata();
  assert.ok(meta.width <= 900 && meta.height <= 900, 'resized');
  assert.equal((await as(staff)('PUT', '/api/admin/media/item', JPG, { 'content-type': 'image/jpeg' })).statusCode, 403);

  const m = (await as(owner)('GET', '/api/admin/menu')).json();
  const cat = m.categories[0];
  const r = await as(owner)('POST', '/api/admin/menu/items', {
    category_id: cat.id, name_ar: 'برجر سحاب', description_ar: 'لحم واغيو مع جبن شيدر', price_minor: 6500,
    image_id: up.json().id, calories: 850, tags: ['popular', 'spicy'], allergens: ['gluten', 'dairy'],
    options: [
      { name_en: 'Size', name_ar: 'الحجم', min: 1, max: 1, choices: [{ name_en: 'Regular', name_ar: 'عادي' }, { name_en: 'Double', name_ar: 'دبل', price_minor: 2000 }] },
      { name_ar: 'إضافات', min: 0, max: 2, choices: [{ name_ar: 'جبن إضافي', price_minor: 300 }, { name_ar: 'بيض', price_minor: 400 }, { name_ar: 'هالبينو', price_minor: 200 }] },
    ],
  });
  assert.equal(r.statusCode, 201, r.body);
  item = r.json();
  assert.equal(item.name_en, '[ar>en] برجر سحاب');
  assert.deepEqual(item.auto_translated.sort(), ['description_en', 'name_en']);
  assert.ok(item.options.every((g) => g.id && g.choices.every((c) => c.id && c.name_en)));
  assert.equal(item.options[1].name_en, '[ar>en] إضافات');

  const bad = await as(owner)('POST', '/api/admin/menu/items', { category_id: cat.id, name_en: 'X', price_minor: 1, tags: ['<script>'] });
  assert.equal(bad.statusCode, 400);
  const foreignImg = await as(owner)('POST', '/api/admin/menu/items', { category_id: cat.id, name_en: 'X', price_minor: 1, image_id: crypto.randomUUID() });
  assert.equal(foreignImg.statusCode, 404);
});

test('Saudi restaurants must give calories (SFDA menu labelling)', async () => {
  await pool.query(`UPDATE restaurants SET country = 'SA' WHERE id = $1`, [S.restaurantId]);
  const cat = (await as(owner)('GET', '/api/admin/menu')).json().categories[0];
  const r = await as(owner)('POST', '/api/admin/menu/items', { category_id: cat.id, name_en: 'Tea', name_ar: 'شاي', price_minor: 500 });
  assert.equal(r.json().error, 'CALORIES_REQUIRED');
  await pool.query(`UPDATE restaurants SET country = 'AE' WHERE id = $1`, [S.restaurantId]);
});

test('banners: scheduled, linked to an item, counted; hidden when inactive or expired', async () => {
  const img = (await as(owner)('PUT', '/api/admin/media/banner', JPG, { 'content-type': 'image/jpeg' })).json();
  const b = await as(owner)('POST', '/api/admin/menu/banners', { image_id: img.id, title_en: 'Burger week', link_type: 'item', link_id: item.id });
  assert.equal(b.statusCode, 201, b.body);
  assert.equal(b.json().title_ar, '[en>ar] Burger week');
  const past = await as(owner)('POST', '/api/admin/menu/banners', { image_id: img.id, link_type: 'none', ends_at: '2020-01-02T00:00:00Z', starts_at: '2020-01-01T00:00:00Z' });
  assert.equal(past.statusCode, 201);
  const v = await view();
  const ids = v.restaurant.menu.banners.map((x) => x.id);
  assert.ok(ids.includes(b.json().id));
  assert.ok(!ids.includes(past.json().id), 'expired banner hidden');
  assert.equal(v.restaurant.menu.banners.find((x) => x.id === b.json().id).link_id, item.id);
  assert.equal((await diner('POST', `/api/t/${S.demoToken}/banners/${b.json().id}/click`, {})).statusCode, 200);
  assert.equal((await diner('POST', `/api/t/${S.demoToken}/banners/seen`, { ids })).statusCode, 200);
  const row = (await pool.query('SELECT clicks, views FROM menu_banners WHERE id = $1', [b.json().id])).rows[0];
  assert.equal(Number(row.clicks), 1);
  assert.equal(Number(row.views), 1);
  await as(owner)('PUT', `/api/admin/menu/banners/${b.json().id}`, { image_id: img.id, link_type: 'none', active: false });
  assert.ok(!(await view()).restaurant.menu.banners.some((x) => x.id === b.json().id));
});

test('ordering: off unless enabled; server prices options; rejects bad choices', async () => {
  await as(owner)('PUT', '/api/admin/menu/settings', { menu_mode: 'browse' });
  const off = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1 }] });
  assert.equal(off.json().error, 'ORDERING_DISABLED');
  await as(owner)('PUT', '/api/admin/menu/settings', { menu_mode: 'order' });
  assert.equal((await view()).restaurant.menu.ordering, true);

  const [size, extras] = item.options;
  const missing = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1 }] });
  assert.equal(missing.json().error, 'OPTIONS_INVALID', 'required size not chosen');
  const tooMany = await diner('POST', `/api/t/${S.demoToken}/orders`, {
    client_key: key(), items: [{ item_id: item.id, qty: 1, options: [size.choices[0].id, ...extras.choices.map((c) => c.id)] }],
  });
  assert.equal(tooMany.json().error, 'OPTIONS_INVALID', 'max 2 extras');
  const noOrigin = await app.inject({ method: 'POST', url: `/api/t/${S.demoToken}/orders`, payload: { client_key: key(), items: [{ item_id: item.id, qty: 1 }] } });
  assert.equal(noOrigin.statusCode, 403);
});

let order;
test('placing an order is idempotent and priced by the server', async () => {
  const [size, extras] = item.options;
  const body = { client_key: key(), note: 'No onions please', items: [{ item_id: item.id, qty: 2, options: [size.choices[1].id, extras.choices[0].id], note: 'well done' }] };
  const a = await diner('POST', `/api/t/${S.demoToken}/orders`, body);
  assert.equal(a.statusCode, 201, a.body);
  order = a.json();
  assert.equal(order.subtotal_minor, 2 * (6500 + 2000 + 300));
  assert.equal(order.status, 'new');
  const again = await diner('POST', `/api/t/${S.demoToken}/orders`, body);
  assert.equal(again.json().id, order.id, 'same client_key returns the same order');
  const list = (await diner('GET', `/api/t/${S.demoToken}/orders`)).json().orders;
  assert.equal(list.length, 1);
  assert.equal(list[0].items[0].options.length, 2);
});

let station;
test('order station: paired by single-use code; sees orders; cannot reach the dashboard', async () => {
  assert.equal((await as(staff)('POST', '/api/admin/devices', { name: 'Kitchen' })).statusCode, 403);
  const d = await as(owner)('POST', '/api/admin/devices', { name: 'Kitchen printer' });
  assert.equal(d.statusCode, 201);
  const code = d.json().pair_url.split('#pair=')[1];
  assert.match(d.json().qr_svg, /<svg/);
  const p = await app.inject({ method: 'POST', url: '/api/station/pair', headers: ORIGIN, payload: { code }, remoteAddress: ip() });
  assert.equal(p.statusCode, 200);
  station = { orderize_station: p.cookies.find((c) => c.name === 'orderize_station').value };
  const reuse = await app.inject({ method: 'POST', url: '/api/station/pair', headers: ORIGIN, payload: { code }, remoteAddress: ip() });
  assert.equal(reuse.json().error, 'PAIR_CODE_INVALID', 'code is single use');

  const b = (await as(station)('GET', '/api/orders/board')).json();
  assert.ok(b.orders.some((o) => o.id === order.id && o.table && o.items[0].note === 'well done'));
  assert.equal((await as(station)('GET', '/api/admin/menu')).statusCode, 401, 'device has no dashboard access');
  assert.equal((await app.inject({ url: '/api/orders/board' })).statusCode, 401);
});

test('accepting adds the order to the table bill (with VAT); statuses move forward only', async () => {
  await pool.query('UPDATE restaurants SET vat_bps = 500 WHERE id = $1', [S.restaurantId]);
  const bad = await as(station)('POST', `/api/orders/${order.id}/status`, { status: 'served' });
  assert.equal(bad.json().error, 'INVALID_TRANSITION');
  const acc = await as(station)('POST', `/api/orders/${order.id}/status`, { status: 'preparing' });
  assert.equal(acc.statusCode, 200, acc.body);
  assert.ok(acc.json().bill_id);
  const v = await view();
  assert.equal(v.bill.total_minor, order.subtotal_minor);
  assert.equal(v.bill.vat_minor, Math.round((order.subtotal_minor * 500) / 10500));
  assert.match(v.bill.items[0].name_en, /Double, Extra|\(.*\)/);
  assert.equal(v.bill.items[0].qty, 2);

  // a second order lands on the same bill
  const o2 = (await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] })).json();
  await as(staff)('POST', `/api/orders/${o2.id}/status`, { status: 'preparing' });
  assert.equal((await view()).bill.total_minor, order.subtotal_minor + 6500);

  for (const s of ['ready', 'served']) assert.equal((await as(station)('POST', `/api/orders/${order.id}/status`, { status: s })).statusCode, 200);
  assert.equal((await as(station)('POST', `/api/orders/${order.id}/status`, { status: 'cancelled' })).json().error, 'INVALID_TRANSITION');
});

test('rejecting a new order keeps it off the bill; pending orders per table are capped', async () => {
  const before = (await view()).bill.total_minor;
  const o = (await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] })).json();
  const c = await as(station)('POST', `/api/orders/${o.id}/status`, { status: 'cancelled', reason: 'Kitchen closed' });
  assert.equal(c.statusCode, 200);
  assert.equal((await view()).bill.total_minor, before);
  for (let i = 0; i < 3; i++) await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] });
  const capped = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] });
  assert.equal(capped.json().error, 'TOO_MANY_PENDING_ORDERS');
});

test('sold-out items cannot be ordered; login can be required', async () => {
  await as(staff)('POST', `/api/admin/menu/items/${item.id}/availability`, { available: false });
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE status = 'new'`);
  const r = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] });
  assert.equal(r.json().error, 'ITEM_SOLD_OUT');
  await as(staff)('POST', `/api/admin/menu/items/${item.id}/availability`, { available: true });
  await as(owner)('PUT', '/api/admin/menu/settings', { order_requires_login: true });
  const l = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1, options: [item.options[0].choices[0].id] }] });
  assert.equal(l.json().error, 'SIGN_IN_REQUIRED');
  await as(owner)('PUT', '/api/admin/menu/settings', { order_requires_login: false });
});

test('waiter calls: one open call per table and kind; resolved by staff; revoked devices are locked out', async () => {
  for (let i = 0; i < 2; i++) assert.equal((await diner('POST', `/api/t/${S.demoToken}/call`, { kind: 'waiter' })).statusCode, 200);
  const calls = (await as(station)('GET', '/api/orders/board')).json().calls;
  assert.equal(calls.filter((c) => c.kind === 'waiter').length, 1);
  assert.equal((await as(station)('POST', `/api/orders/calls/${calls[0].id}/resolve`, {})).statusCode, 200);
  assert.equal((await as(station)('GET', '/api/orders/board')).json().calls.length, 0);

  const dev = (await as(owner)('GET', '/api/admin/devices')).json().devices[0];
  assert.ok(dev.paired_at);
  assert.equal((await as(owner)('DELETE', `/api/admin/devices/${dev.id}`)).statusCode, 200);
  assert.equal((await as(station)('GET', '/api/orders/board')).statusCode, 401);
});

test('file mode shows only the uploaded menu and disables ordering', async () => {
  await as(owner)('PUT', '/api/admin/menu/settings', { menu_mode: 'file' });
  const m = (await view()).restaurant.menu;
  assert.equal(m.mode, 'file');
  assert.deepEqual(m.categories, []);
  assert.equal(m.ordering, false);
  const r = await diner('POST', `/api/t/${S.demoToken}/orders`, { client_key: key(), items: [{ item_id: item.id, qty: 1 }] });
  assert.equal(r.json().error, 'ORDERING_DISABLED');
});
