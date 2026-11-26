import crypto from 'node:crypto';
import { z } from 'zod';
import { tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../services/bills.js';

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
const opt = (n) => z.string().trim().max(n).nullable().optional();
const category = z.strictObject({ name_en: t(80), name_ar: t(80), position: z.number().int().min(0).max(10000).optional() });
const item = z.strictObject({
  category_id: z.uuid(), name_en: t(120), name_ar: t(120),
  description_en: opt(300), description_ar: opt(300),
  price_minor: z.number().int().min(0).max(100_000_000),
  available: z.boolean().default(true), position: z.number().int().min(0).max(10000).optional(),
});
const importRows = z.strictObject({
  replace: z.boolean().default(false),
  rows: z.array(z.strictObject({
    category_en: t(80), category_ar: t(80).optional(), name_en: t(120), name_ar: t(120).optional(),
    price_minor: z.number().int().min(0).max(100_000_000), description_en: opt(300), description_ar: opt(300),
  })).min(1).max(MAX_ITEMS),
});

/** Restaurant menu editor. Registered inside the admin plugin (session + CSRF hooks apply). */
export default async function menuRoutes(app, { ctx, auth, rid }) {
  const { pool } = ctx;

  // Binary uploads: buffered with their own size limit, only on the upload route.
  for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_PDF }, (req, body, done) => done(null, body));
  }

  app.get('/api/admin/menu', { preHandler: auth('staff') }, async (req) => {
    const r = rid(req);
    const [cats, items, files] = await Promise.all([
      pool.query('SELECT id, name_en, name_ar, position FROM menu_categories WHERE restaurant_id = $1 ORDER BY position, created_at', [r]),
      pool.query(
        `SELECT id, category_id, name_en, name_ar, description_en, description_ar, price_minor, available, position
           FROM menu_items WHERE restaurant_id = $1 ORDER BY position, created_at`, [r],
      ),
      pool.query('SELECT id, kind, mime, size, position, created_at FROM media WHERE restaurant_id = $1 ORDER BY kind, position, created_at', [r]),
    ]);
    return {
      categories: cats.rows.map((c) => ({ ...c, items: items.rows.filter((i) => i.category_id === c.id) })),
      files: files.rows,
    };
  });

  app.post('/api/admin/menu/categories', { preHandler: auth('manager') }, async (req, reply) => {
    const b = category.parse(req.body);
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

  app.post('/api/admin/menu/items', { preHandler: auth('manager') }, async (req, reply) => {
    const b = item.parse(req.body);
    await ownCategory(req, b.category_id);
    const count = (await pool.query('SELECT count(*)::int AS n FROM menu_items WHERE restaurant_id = $1', [rid(req)])).rows[0].n;
    if (count >= MAX_ITEMS) throw new HttpError(422, 'MENU_TOO_LARGE');
    const { rows: [i] } = await pool.query(
      `INSERT INTO menu_items(restaurant_id, category_id, name_en, name_ar, description_en, description_ar, price_minor, available, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9, (SELECT coalesce(max(position),0)+1 FROM menu_items WHERE category_id = $2)))
       RETURNING *`,
      [rid(req), b.category_id, b.name_en, b.name_ar, b.description_en ?? null, b.description_ar ?? null, b.price_minor, b.available, b.position ?? null],
    );
    reply.code(201);
    return i;
  });

  app.put('/api/admin/menu/items/:id', { preHandler: auth('manager') }, async (req) => {
    const b = item.parse(req.body);
    await ownCategory(req, b.category_id);
    const { rowCount } = await pool.query(
      `UPDATE menu_items SET category_id = $3, name_en = $4, name_ar = $5, description_en = $6, description_ar = $7,
              price_minor = $8, available = $9, position = coalesce($10, position)
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, rid(req), b.category_id, b.name_en, b.name_ar, b.description_en ?? null, b.description_ar ?? null, b.price_minor, b.available, b.position ?? null],
    );
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  // Staff can mark an item sold out without being able to change prices.
  app.post('/api/admin/menu/items/:id/availability', { preHandler: auth('staff') }, async (req) => {
    const available = z.boolean().parse(req.body?.available);
    const { rowCount } = await pool.query('UPDATE menu_items SET available = $3 WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req), available]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
    return { ok: true };
  });

  app.delete('/api/admin/menu/items/:id', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query('DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND');
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
        `INSERT INTO media(restaurant_id, kind, mime, bytes, size, sha256, position)
         VALUES ($1,$2,$3,$4,$5,$6, (SELECT coalesce(max(position),0)+1 FROM media WHERE restaurant_id = $1 AND kind = $2))
         RETURNING id, kind, mime, size, position`,
        [r, kind, real, buf, buf.length, crypto.createHash('sha256').update(buf).digest('hex')],
      );
      return m;
    });
    await audit(pool, { actorType: 'user', actorId: req.user.id, restaurantId: r, action: 'menu.file_uploaded', target: row.id, ip: req.ip, meta: { kind, size: buf.length } });
    reply.code(201);
    return row;
  });

  app.delete('/api/admin/menu/files/:id', { preHandler: auth('manager') }, async (req) => {
    const { rowCount } = await pool.query('DELETE FROM media WHERE id = $1 AND restaurant_id = $2', [req.params.id, rid(req)]);
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

/** Menu as diners see it: managed items, else the legacy JSON menu; plus uploaded files. */
export async function publicMenu(db, restaurant) {
  const [cats, items, files] = await Promise.all([
    db.query('SELECT id, name_en, name_ar FROM menu_categories WHERE restaurant_id = $1 ORDER BY position, created_at', [restaurant.id]),
    db.query(
      `SELECT category_id, name_en, name_ar, description_en, description_ar, price_minor
         FROM menu_items WHERE restaurant_id = $1 AND available ORDER BY position, created_at`, [restaurant.id],
    ),
    db.query(`SELECT id, kind FROM media WHERE restaurant_id = $1 ORDER BY position, created_at`, [restaurant.id]),
  ]);
  const pdf = files.rows.find((f) => f.kind === 'menu_pdf')?.id ?? null;
  const images = files.rows.filter((f) => f.kind === 'menu_image').map((f) => f.id);
  // When the restaurant uploaded its own menu (PDF/photos), diners see only that design.
  // The item list then stays internal: it is what staff pick from to build the bill.
  if (pdf || images.length) return { categories: [], pdf, images };
  const categories = cats.rows.length
    ? cats.rows.map((c) => ({ name_en: c.name_en, name_ar: c.name_ar, items: items.rows.filter((i) => i.category_id === c.id).map(({ category_id, ...i }) => i) }))
      .filter((c) => c.items.length)
    : restaurant.menu ?? [];
  return {
    categories, pdf: null, images: [],
  };
}
