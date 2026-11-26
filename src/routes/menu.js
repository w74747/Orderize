import crypto from 'node:crypto';
import { z } from 'zod';
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../services/bills.js';
import { processImage } from '../lib/images.js';

const MAX_PDF = 10 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 20;
const MAX_ITEMS = 1000;

/** File type from magic bytes. The declared Content-Type must agree with it. */
export function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const t = (n) => z.string().trim().min(1).max(n);
const opt = (n) => z.string().trim().max(n).nullable().optional().transform((v) => v || null);
const uuidOrNull = z.uuid().nullable().optional();
export const TAGS = ['vegetarian', 'vegan', 'spicy', 'new', 'popular', 'gluten_free', 'chef', 'healthy'];
export const ALLERGENS = ['gluten', 'dairy', 'egg', 'nuts', 'peanuts', 'sesame', 'soy', 'fish', 'shellfish', 'mustard', 'celery'];
const bothNames = (o) => Boolean(o.name_en || o.name_ar);

const category = z.strictObject({ name_en: opt(80), name_ar: opt(80), position: z.number().int().min(0).max(10000).optional() })
  .refine(bothNames, 'name required');
const choice = z.strictObject({ id: z.uuid().optional(), name_en: opt(60), name_ar: opt(60), price_minor: z.number().int().min(0).max(10_000_000).default(0) })
  .refine(bothNames, 'choice name required');
const group = z.strictObject({
  id: z.uuid().optional(), name_en: opt(60), name_ar: opt(60),
  min: z.number().int().min(0).max(20).default(0), max: z.number().int().min(1).max(20).default(1),
  choices: z.array(choice).min(1).max(30),
}).refine(bothNames, 'group name required').refine((g) => g.min <= g.max && g.min <= g.choices.length, 'min/max');
const item = z.strictObject({
  category_id: z.uuid(), name_en: opt(120), name_ar: opt(120),
  description_en: opt(300), description_ar: opt(300),
  price_minor: z.number().int().min(0).max(100_000_000),
  available: z.boolean().default(true), position: z.number().int().min(0).max(10000).optional(),
  image_id: uuidOrNull,
  calories: z.number().int().min(0).max(20000).nullable().optional(),
  caffeine_mg: z.number().int().min(0).max(2000).nullable().optional(),
  high_salt: z.boolean().default(false),
  tags: z.array(z.enum(TAGS)).max(TAGS.length).default([]),
  allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length).default([]),
  options: z.array(group).max(10).default([]),
}).refine(bothNames, 'name required');
const importRows = z.strictObject({
  replace: z.boolean().default(false),
  rows: z.array(z.strictObject({
    category_en: t(80), category_ar: t(80).optional(), name_en: t(120), name_ar: t(120).optional(),
    price_minor: z.number().int().min(0).max(100_000_000), description_en: opt(300), description_ar: opt(300),
  })).min(1).max(MAX_ITEMS),
});
const banner = z.strictObject({
  image_id: z.uuid(), title_en: opt(80), title_ar: opt(80),
  link_type: z.enum(['none', 'item', 'category']).default('none'), link_id: uuidOrNull,
  starts_at: z.iso.datetime({ offset: true }).nullable().optional(), ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
  active: z.boolean().default(true), position: z.number().int().min(0).max(1000).optional(),
}).refine((b) => b.link_type === 'none' || b.link_id, 'link_id required')
  .refine((b) => !b.starts_at || !b.ends_at || new Date(b.ends_at) > new Date(b.starts_at), 'ends_at must be after starts_at');
const menuSettings = z.strictObject({
  menu_mode: z.enum(['file', 'browse', 'order']).optional(),
  order_requires_login: z.boolean().optional(),
  waiter_call_enabled: z.boolean().optional(),
});

/** Fills the missing language of every {name_en,name_ar}-like object, in one call per direction. */
async function translateObjects(ctx, restaurantId, objs, fields) {
  const auto = new Set();
  for (const [from, to] of [['ar', 'en'], ['en', 'ar']]) {
    const todo = [];
    for (const o of objs) for (const f of fields) if (o[`${f}_${from}`] && !o[`${f}_${to}`]) todo.push([o, f]);
    if (!todo.length) continue;
    const res = await ctx.translator.translate(ctx.pool, restaurantId, todo.map(([o, f]) => o[`${f}_${from}`]), from, to);
    todo.forEach(([o, f], i) => {
      if (res?.[i]) { o[`${f}_${to}`] = res[i]; o.__auto = [...(o.__auto ?? []), `${f}_${to}`]; }
      else if (f === 'name') o[`${f}_${to}`] = o[`${f}_${from}`]; // names are required on both sides; copy if no translation
    });
  }
  for (const o of objs) { for (const a of o.__auto ?? []) auto.add(a); }
  return auto;
}

/** Restaurant menu editor. Registered inside the admin plugin (session + CSRF hooks apply). */
export default async function menuRoutes(app, { ctx, auth, rid }) {
  const { pool } = ctx;
  const actor = (req) => ({ actorType: 'user', actorId: req.user.id, restaurantId: rid(req), ip: req.ip });

  // Binary uploads: buffered with their own size limit, only on the upload routes (see admin hook).
  for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_PDF }, (req, body, done) => done(null, body));
  }

  app.get('/api/admin/menu', { preHandler: auth('staff') }, async (req) => {
    const r = rid(req);
    const [cats, items, files, banners, rest] = await Promise.all([
      pool.query('SELECT id, name_en, name_ar, position FROM menu_categories WHERE restaurant_id = $1 ORDER BY position, created_at', [r]),
      pool.query(
        `SELECT id, category_id, name_en, name_ar, description_en, description_ar, price_minor, available, position,
                image_id, calories, caffeine_mg, high_salt, tags, allergens, options, auto_translated
           FROM menu_items WHERE restaurant_id = $1 ORDER BY position, created_at`, [r],
      ),
      pool.query(`SELECT id, kind, mime, size, position, created_at FROM media WHERE restaurant_id = $1 AND kind IN ('menu_pdf','menu_image') ORDER BY kind, position, created_at`, [r]),
      pool.query('SELECT * FROM menu_banners WHERE restaurant_id = $1 ORDER BY position, created_at', [r]),
      pool.query('SELECT country, currency, menu_mode, order_requires_login, waiter_call_enabled, logo_media, cover_media FROM restaurants WHERE id = $1', [r]),
    ]);
    return {
      settings: { ...rest.rows[0], translation: ctx.translator.enabled },
      categories: cats.rows.map((c) => ({ ...c, items: items.rows.filter((i) => i.category_id === c.id) })),
      banners: banners.rows,
      files: files.rows,
      tags: TAGS, allergens: ALLERGENS,
    };
  });

  app.put('/api/admin/menu/settings', { preHandler: auth('manager') }, async (req) => {
    const b = menuSettings.parse(req.body);
    await pool.query(
      `UPDATE restaurants SET menu_mode = coalesce($2, menu_mode), order_requires_login = coalesce($3, order_requires_login),
              waiter_call_enabled = coalesce($4, waiter_call_enabled) WHERE id = $1`,
      [rid(req), b.menu_mode ?? null, b.order_requires_login ?? null, b.waiter_call_enabled ?? null],
    );
    await audit(pool, { ...actor(req), action: 'menu.settings_updated', meta: b });
    return { ok: true };
  });

  // ---- categories
  app.post('/api/admin/menu/categories', { preHandler: auth('manager') }, async (req, reply) => {
    const b = category.parse(req.body);
    await translateObjects(ctx, rid(req), [b], ['name']);
    const { rows: [c] } = await pool.query(
      `INSERT INTO menu_categories(restaurant_id, name_en, name_ar, position)
       VALUES ($1,$2,$3, coalesce($4, (SELECT coalesce(max(position),0)+1 FROM menu_categories WHERE restaurant_id = $1)))
       RETURNING id, name_en, name_ar, position`,
      [rid(req), b.name_en, b.name_ar, b.position ?? null],
    );
    reply.code(201);
    return c;
  });

  app.put('/api/admin/menu/categories/:id', { preHandler: auth('manager') }, async (req) => {
    const b = category.parse(req.body);
    await translateObjects(ctx, rid(req), [b], ['name']);
    const { rowCount } = await pool.query(
      'UPDATE menu_categories SET name_en = $3, name_ar = $4, position = coalesce($5, position) WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, rid(req), b.name_en, b.name_ar, b.position ?? null],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  app.delete('/api/admin/menu/categories/:id', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query('DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  async function ownCategory(req, categoryId) {
    const r = await pool.query('SELECT 1 FROM menu_categories WHERE id = $1 AND restaurant_id = $2', [categoryId, rid(req)]);
    if (!r.rowCount) throw new HttpError(404, 'CATEGORY_NOT_FOUND'); // never attach items to another restaurant's category
  }
  async function ownMedia(req, id, kind) {
    if (!id) return;
    const r = await pool.query('SELECT 1 FROM media WHERE id = $1 AND restaurant_id = $2 AND kind = $3', [id, rid(req), kind]);
    if (!r.rowCount) throw new HttpError(404, 'IMAGE_NOT_FOUND');
  }

  /** Validates and completes an item: ownership, SFDA calories, ids for options, translations. */
  async function prepareItem(req) {
    const b = item.parse(req.body);
    await ownCategory(req, b.category_id);
    await ownMedia(req, b.image_id, 'item');
    const { rows: [rest] } = await pool.query('SELECT country FROM restaurants WHERE id = $1', [rid(req)]);
    if (rest.country === 'SA' && b.calories == null) throw new HttpError(422, 'CALORIES_REQUIRED'); // SFDA menu labelling
    const opts = b.options.map((g) => ({ ...g, id: g.id ?? crypto.randomUUID(), choices: g.choices.map((c) => ({ ...c, id: c.id ?? crypto.randomUUID() })) }));
    const auto = await translateObjects(ctx, rid(req), [b], ['name', 'description']);
    await translateObjects(ctx, rid(req), [...opts, ...opts.flatMap((g) => g.choices)], ['name']);
    const clean = (o) => { const { __auto, ...rest } = o; return rest; };
    return { ...clean(b), options: opts.map((g) => ({ ...clean(g), choices: g.choices.map(clean) })), auto: [...auto] };
  }

  async function dropMediaIfUnused(id) {
    if (!id) return;
    await pool.query(
      `DELETE FROM media m WHERE m.id = $1 AND m.kind = 'item'
         AND NOT EXISTS (SELECT 1 FROM menu_items i WHERE i.image_id = m.id)`, [id],
    );
  }

  const ITEM_COLS = 'category_id, name_en, name_ar, description_en, description_ar, price_minor, available, image_id, calories, caffeine_mg, high_salt, tags, allergens, options, auto_translated';
  const itemParams = (b) => [b.category_id, b.name_en, b.name_ar, b.description_en, b.description_ar, b.price_minor, b.available,
    b.image_id ?? null, b.calories ?? null, b.caffeine_mg ?? null, b.high_salt, b.tags, b.allergens, JSON.stringify(b.options), b.auto];

  app.post('/api/admin/menu/items', { preHandler: auth('manager') }, async (req, reply) => {
    const b = await prepareItem(req);
    const count = (await pool.query('SELECT count(*)::int AS n FROM menu_items WHERE restaurant_id = $1', [rid(req)])).rows[0].n;
    if (count >= MAX_ITEMS) throw new HttpError(422, 'MENU_TOO_LARGE');
    const { rows: [i] } = await pool.query(
      `INSERT INTO menu_items(restaurant_id, ${ITEM_COLS}, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               coalesce($17, (SELECT coalesce(max(position),0)+1 FROM menu_items WHERE category_id = $2)))
       RETURNING *`,
      [rid(req), ...itemParams(b), b.position ?? null],
    );
    reply.code(201);
    return i;
  });

  app.put('/api/admin/menu/items/:id', { preHandler: auth('manager') }, async (req) => {
    const b = await prepareItem(req);
    const old = await pool.query('SELECT image_id FROM menu_items WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
    if (!old.rowCount) throw new HttpError(404, 'NOT_FOUND');
    await pool.query(
      `UPDATE menu_items SET (${ITEM_COLS}) = ($3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17),
              position = coalesce($18, position)
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, rid(req), ...itemParams(b), b.position ?? null],
    );
    if (old.rows[0].image_id !== (b.image_id ?? null)) await dropMediaIfUnused(old.rows[0].image_id);
    return { ok: true, auto_translated: b.auto };
  });

  // Staff can mark an item sold out without being able to change prices.
  app.post('/api/admin/menu/items/:id/availability', { preHandler: auth('staff') }, async (req) => {
    const available = z.boolean().parse(req.body?.available);
    const { rowCount } = await pool.query('UPDATE menu_items SET available = $3 WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req), available]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  app.delete('/api/admin/menu/items/:id', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query('DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2 RETURNING image_id', [req.params.id, rid(req)]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND');
    await dropMediaIfUnused(rows[0].image_id);
    return { ok: true };
  });

  // ---- images: logo, cover, item photos, banners. Re-encoded server-side.
  app.put('/api/admin/media/:kind', { preHandler: auth('manager'), config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const kind = z.enum(['logo', 'cover', 'item', 'banner']).parse(req.params.kind);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'EMPTY_FILE');
    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const real = sniff(buf);
    if (!real || real === 'application/pdf' || real !== declared) throw new HttpError(415, 'UNSUPPORTED_FILE');
    if (buf.length > MAX_IMAGE * 2) throw new HttpError(413, 'FILE_TOO_LARGE');
    let img;
    try { img = await processImage(buf, kind); } catch { throw new HttpError(415, 'UNSUPPORTED_FILE'); }
    const r = rid(req);
    const row = await tx(pool, async (db) => {
      const { rows: [m] } = await db.query(
        `INSERT INTO media(restaurant_id, kind, mime, bytes, size, sha256, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, width, height`,
        [r, kind, img.mime, img.bytes, img.bytes.length, crypto.createHash('sha256').update(img.bytes).digest('hex'), img.width, img.height],
      );
      if (kind === 'logo' || kind === 'cover') {
        const col = kind === 'logo' ? 'logo_media' : 'cover_media';
        const { rows: [prev] } = await db.query(`SELECT ${col} AS id FROM restaurants WHERE id = $1 FOR UPDATE`, [r]);
        await db.query(`UPDATE restaurants SET ${col} = $2 WHERE id = $1`, [r, m.id]);
        if (prev.id) await db.query('DELETE FROM media WHERE id = $1 AND restaurant_id = $2', [prev.id, r]);
      }
      return m;
    });
    await audit(pool, { ...actor(req), action: 'menu.image_uploaded', target: row.id, meta: { kind } });
    reply.code(201);
    return { ...row, url: `/media/${row.id}` };
  });

  app.delete('/api/admin/media/branding/:kind', { preHandler: auth('manager') }, async (req) => {
    const col = { logo: 'logo_media', cover: 'cover_media' }[req.params.kind];
    if (!col) throw new HttpError(404, 'NOT_FOUND');
    await tx(pool, async (db) => {
      const { rows: [prev] } = await db.query(`SELECT ${col} AS id FROM restaurants WHERE id = $1 FOR UPDATE`, [rid(req)]);
      await db.query(`UPDATE restaurants SET ${col} = NULL WHERE id = $1`, [rid(req)]);
      if (prev.id) await db.query('DELETE FROM media WHERE id = $1 AND restaurant_id = $2', [prev.id, rid(req)]);
    });
    return { ok: true };
  });

  // ---- promotional banners
  async function prepareBanner(req) {
    const b = banner.parse(req.body);
    await ownMedia(req, b.image_id, 'banner');
    if (b.link_type === 'item') {
      if (!(await pool.query('SELECT 1 FROM menu_items WHERE id = $1 AND restaurant_id = $2', [b.link_id, rid(req)])).rowCount) throw new HttpError(404, 'LINK_NOT_FOUND');
    } else if (b.link_type === 'category') {
      await ownCategory(req, b.link_id);
    } else b.link_id = null;
    await translateObjects(ctx, rid(req), [b], ['title']);
    delete b.__auto;
    return b;
  }
  const BANNER_COLS = 'image_id, title_en, title_ar, link_type, link_id, starts_at, ends_at, active';
  const bannerParams = (b) => [b.image_id, b.title_en, b.title_ar, b.link_type, b.link_id ?? null, b.starts_at ?? null, b.ends_at ?? null, b.active];

  app.post('/api/admin/menu/banners', { preHandler: auth('manager') }, async (req, reply) => {
    const b = await prepareBanner(req);
    const n = (await pool.query('SELECT count(*)::int AS n FROM menu_banners WHERE restaurant_id = $1', [rid(req)])).rows[0].n;
    if (n >= 12) throw new HttpError(422, 'TOO_MANY_BANNERS');
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_banners(restaurant_id, ${BANNER_COLS}, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
         coalesce($10, (SELECT coalesce(max(position),0)+1 FROM menu_banners WHERE restaurant_id = $1))) RETURNING *`,
      [rid(req), ...bannerParams(b), b.position ?? null],
    );
    reply.code(201);
    return row;
  });

  app.put('/api/admin/menu/banners/:id', { preHandler: auth('manager') }, async (req) => {
    const b = await prepareBanner(req);
    const { rows } = await pool.query('SELECT image_id FROM menu_banners WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND');
    await pool.query(
      `UPDATE menu_banners SET (${BANNER_COLS}) = ($3,$4,$5,$6,$7,$8,$9,$10), position = coalesce($11, position)
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, rid(req), ...bannerParams(b), b.position ?? null],
    );
    if (rows[0].image_id !== b.image_id) await pool.query(`DELETE FROM media WHERE id = $1 AND kind = 'banner'`, [rows[0].image_id]);
    return { ok: true };
  });

  app.delete('/api/admin/menu/banners/:id', { preHandler: auth('manager') }, async (req) => {
    const { rows } = await pool.query('DELETE FROM menu_banners WHERE id = $1 AND restaurant_id = $2 RETURNING image_id', [req.params.id, rid(req)]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND');
    await pool.query(`DELETE FROM media WHERE id = $1 AND kind = 'banner'`, [rows[0].image_id]);
    return { ok: true };
  });

  // Bulk import from a spreadsheet (pasted CSV, parsed in the browser into rows).
  app.post('/api/admin/menu/import', { preHandler: auth('manager'), bodyLimit: 512 * 1024 }, async (req) => {
    const b = importRows.parse(req.body);
    const r = rid(req);
    const res = await tx(pool, async (db) => {
      if (b.replace) await db.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [r]);
      const cats = new Map((await db.query('SELECT id, name_en FROM menu_categories WHERE restaurant_id = $1', [r])).rows.map((c) => [c.name_en.toLowerCase(), c.id]));
      let created = 0, pos = 0;
      for (const row of b.rows) {
        let cid = cats.get(row.category_en.toLowerCase());
        if (!cid) {
          cid = (await db.query(
            'INSERT INTO menu_categories(restaurant_id, name_en, name_ar, position) VALUES ($1,$2,$3,$4) RETURNING id',
            [r, row.category_en, row.category_ar ?? row.category_en, cats.size + 1],
          )).rows[0].id;
          cats.set(row.category_en.toLowerCase(), cid);
        }
        await db.query(
          `INSERT INTO menu_items(restaurant_id, category_id, name_en, name_ar, description_en, description_ar, price_minor, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r, cid, row.name_en, row.name_ar ?? row.name_en, row.description_en ?? null, row.description_ar ?? null, row.price_minor, pos++],
        );
        created++;
      }
      const total = (await db.query('SELECT count(*)::int AS n FROM menu_items WHERE restaurant_id = $1', [r])).rows[0].n;
      if (total > MAX_ITEMS) throw new HttpError(422, 'MENU_TOO_LARGE');
      return { created, categories: cats.size };
    });
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: r, action: 'menu.imported', ip: req.ip, meta: res });
    return res;
  });

  // ---- menu files (PDF / images)
  app.put('/api/admin/menu/files', { preHandler: auth('manager'), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'EMPTY_FILE');
    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const real = sniff(buf);
    if (!real || real !== declared) throw new HttpError(415, 'UNSUPPORTED_FILE');
    const kind = real === 'application/pdf' ? 'menu_pdf' : 'menu_image';
    if (buf.length > (kind === 'menu_pdf' ? MAX_PDF : MAX_IMAGE)) throw new HttpError(413, 'FILE_TOO_LARGE');
    let file = { bytes: buf, mime: real, width: null, height: null };
    if (kind === 'menu_image') {
      try { file = await processImage(buf, 'menu_image'); } catch { throw new HttpError(415, 'UNSUPPORTED_FILE'); }
    }
    const r = rid(req);
    const row = await tx(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`media:${r}`]);
      if (kind === 'menu_pdf') {
        await db.query(`DELETE FROM media WHERE restaurant_id = $1 AND kind = 'menu_pdf'`, [r]); // one PDF menu; a new upload replaces it
      } else {
        const n = (await db.query(`SELECT count(*)::int AS n FROM media WHERE restaurant_id = $1 AND kind = 'menu_image'`, [r])).rows[0].n;
        if (n >= MAX_IMAGES) throw new HttpError(422, 'TOO_MANY_IMAGES');
      }
      const { rows: [m] } = await db.query(
        `INSERT INTO media(restaurant_id, kind, mime, bytes, size, sha256, width, height, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, (SELECT coalesce(max(position),0)+1 FROM media WHERE restaurant_id = $1 AND kind = $2))
         RETURNING id, kind, mime, size, position`,
        [r, kind, file.mime, file.bytes, file.bytes.length, crypto.createHash('sha256').update(file.bytes).digest('hex'), file.width, file.height],
      );
      return m;
    });
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: r, action: 'menu.file_uploaded', target: row.id, ip: req.ip, meta: { kind, size: file.bytes.length } });
    reply.code(201);
    return row;
  });

  app.delete('/api/admin/menu/files/:id', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query(`DELETE FROM media WHERE id = $1 AND restaurant_id = $2 AND kind IN ('menu_pdf','menu_image')`, [req.params.id, rid(req)]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });
}

/** Public file serving. Ids are random UUIDs; files of suspended restaurants are not served. */
export async function mediaRoutes(app, { ctx }) {
  app.get('/media/:id', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows: [m] } = await ctx.pool.query(
      `SELECT m.mime, m.bytes, m.sha256 FROM media m JOIN restaurants r ON r.id = m.restaurant_id WHERE m.id = $1 AND r.active`,
      [req.params.id],
    );
    if (!m) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply
      .header('content-type', m.mime)
      .header('content-disposition', m.mime === 'application/pdf' ? 'inline; filename="menu.pdf"' : 'inline')
      .header('cache-control', 'public, max-age=3600')
      .header('etag', `"${m.sha256.slice(0, 32)}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'same-origin');
    if (m.mime !== 'application/pdf') reply.header('content-security-policy', "default-src 'none'; img-src 'self'; sandbox");
    return reply.send(m.bytes);
  });
}

/** Menu as diners see it. In "file" mode only the uploaded files; otherwise the interactive menu. */
export async function publicMenu(db, restaurant) {
  const mode = restaurant.menu_mode ?? 'browse';
  const base = {
    mode, ordering: mode === 'order', requires_login: Boolean(restaurant.order_requires_login),
    waiter_call: restaurant.waiter_call_enabled !== false,
    logo: restaurant.logo_media ? `/media/${restaurant.logo_media}` : null,
    cover: restaurant.cover_media ? `/media/${restaurant.cover_media}` : null,
    categories: [], banners: [], pdf: null, images: [],
  };
  if (mode === 'file') {
    const files = await db.query(`SELECT id, kind FROM media WHERE restaurant_id = $1 AND kind IN ('menu_pdf','menu_image') ORDER BY position, created_at`, [restaurant.id]);
    return {
      ...base, ordering: false,
      pdf: files.rows.find((f) => f.kind === 'menu_pdf')?.id ?? null,
      images: files.rows.filter((f) => f.kind === 'menu_image').map((f) => f.id),
    };
  }
  const [cats, items, banners] = await Promise.all([
    db.query('SELECT id, name_en, name_ar FROM menu_categories WHERE restaurant_id = $1 ORDER BY position, created_at', [restaurant.id]),
    db.query(
      `SELECT id, category_id, name_en, name_ar, description_en, description_ar, price_minor, available, image_id,
              calories, caffeine_mg, high_salt, tags, allergens, options
         FROM menu_items WHERE restaurant_id = $1 ORDER BY position, created_at`, [restaurant.id],
    ),
    db.query(
      `SELECT id, image_id, title_en, title_ar, link_type, link_id FROM menu_banners
        WHERE restaurant_id = $1 AND active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
        ORDER BY position, created_at`, [restaurant.id],
    ),
  ]);
  const categories = cats.rows.length
    ? cats.rows.map((c) => ({
      id: c.id, name_en: c.name_en, name_ar: c.name_ar,
      items: items.rows.filter((i) => i.category_id === c.id).map(({ category_id, image_id, ...i }) => ({ ...i, image: image_id ? `/media/${image_id}` : null })),
    })).filter((c) => c.items.length)
    : (restaurant.menu ?? []);
  return {
    ...base,
    ordering: mode === 'order' && cats.rows.length > 0,
    categories,
    banners: banners.rows.map(({ image_id, ...b }) => ({ ...b, image: `/media/${image_id}` })),
  };
}

/** Deletes uploaded item/banner pictures that were never attached (abandoned editor sessions). */
export async function cleanupOrphanMedia(pool) {
  await pool.query(
    `DELETE FROM media m WHERE m.kind IN ('item','banner') AND m.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM menu_items i WHERE i.image_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM menu_banners b WHERE b.image_id = m.id)`,
  );
}
