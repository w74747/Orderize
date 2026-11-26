// Demo data. Bank names are FICTIONAL placeholders — replace with real partner banks
// only after signing an offer agreement with them.
import { createPool, tx } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword, randomToken } from '../src/lib/crypto.js';

export async function seed(pool, { ownerPassword, quiet = false } = {}) {
  const generated = !ownerPassword;
  if (generated) ownerPassword = randomToken(12);
  await migrate(pool);
  return tx(pool, async (c) => {
    const menu = [
      { name_en: 'Breakfast', name_ar: 'الفطور', items: [
        { name_en: 'Avo Toast With Poached Egg', name_ar: 'توست أفوكادو مع بيض مسلوق', price_minor: 5400 },
        { name_en: 'Shakshuka', name_ar: 'شكشوكة', price_minor: 4200 },
      ] },
      { name_en: 'Drinks', name_ar: 'المشروبات', items: [
        { name_en: 'Spanish Latte Hot', name_ar: 'سبانش لاتيه ساخن', price_minor: 3200 },
        { name_en: 'Berry Cloudy', name_ar: 'بيري كلاودي', price_minor: 4100 },
      ] },
    ];
    const { rows: [r] } = await c.query(
      `INSERT INTO restaurants(slug, name_en, name_ar, country, currency, brand_color, default_tip_percent, fee_bps, menu)
       VALUES ('sahab-cafe','Sahab Café','مقهى سحاب','AE','AED','#0b4f7c',7,175,$1)
       ON CONFLICT (slug) DO UPDATE SET name_en = EXCLUDED.name_en RETURNING id`,
      [JSON.stringify(menu)],
    );
    const { rows: [r2] } = await c.query(
      `INSERT INTO restaurants(slug, name_en, name_ar, country, currency, brand_color, default_tip_percent, fee_bps)
       VALUES ('qahwat-al-bahr','Qahwat Al Bahr','قهوة البحر','OM','OMR','#7a4b1f',5,150)
       ON CONFLICT (slug) DO UPDATE SET name_en = EXCLUDED.name_en RETURNING id`,
    );

    const tables = {};
    for (const [rid, labels] of [[r.id, ['S1 T1', 'S1 T2', 'S1 T3', 'S2 T1']], [r2.id, ['A1', 'A2']]]) {
      for (const label of labels) {
        const { rows } = await c.query(
          `INSERT INTO dining_tables(restaurant_id, label, public_token) VALUES ($1,$2,$3)
           ON CONFLICT (restaurant_id, label) DO UPDATE SET label = EXCLUDED.label RETURNING id, public_token`,
          [rid, label, randomToken(18)],
        );
        tables[`${rid}:${label}`] = rows[0];
      }
    }

    async function bill(rid, label, cur, items) {
      const t = tables[`${rid}:${label}`];
      await c.query(`UPDATE bills SET status = 'void', closed_at = now() WHERE table_id = $1 AND status = 'open'`, [t.id]);
      const total = items.reduce((s, i) => s + i[2] * i[3], 0);
      const { rows: [b] } = await c.query(
        `INSERT INTO bills(restaurant_id, table_id, currency, total_minor, vat_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [rid, t.id, cur, total, Math.round(total - total / 1.05)],
      );
      let pos = 0;
      for (const [en, ar, price, qty] of items) {
        await c.query(
          'INSERT INTO bill_items(bill_id, name_en, name_ar, unit_price_minor, qty, position) VALUES ($1,$2,$3,$4,$5,$6)',
          [b.id, en, ar, price, qty, pos++],
        );
      }
      return t.public_token;
    }

    const demoToken = await bill(r.id, 'S1 T1', 'AED', [
      ['Avo Toast With Poached Egg', 'توست أفوكادو مع بيض مسلوق', 5400, 2],
      ['Spanish Latte Hot', 'سبانش لاتيه ساخن', 3200, 2],
      ['Berry Cloudy', 'بيري كلاودي', 4100, 1],
    ]);
    const omrToken = await bill(r2.id, 'A1', 'OMR', [
      ['Karak Tea', 'شاي كرك', 600, 3],
      ['Omani Halwa Plate', 'صحن حلوى عمانية', 2250, 1],
      ['Mixed Grill', 'مشاوي مشكلة', 6500, 2],
    ]);

    const bankOffers = [
      ['percent', 10, 2000, null, 'AED', '10% off · up to 20', 'خصم 10٪ · حتى 20', 'Gulf Digital Bank', 'dark', ['424242', '555555']],
      ['fixed', 5000, null, 20000, 'AED', '50 off · min 200', 'خصم 50 · بحد أدنى 200', 'Desert Bank', 'blue', ['411111']],
      ['percent', 15, 1500, null, 'OMR', '15% off · up to 1.5', 'خصم 15٪ · حتى 1.5', 'Muscat Sample Bank', 'green', ['424242']],
    ];
    for (const o of bankOffers) {
      await c.query(
        `INSERT INTO offers(restaurant_id, kind, value, max_minor, min_spend_minor, currency, title_en, title_ar, bank_name, theme, bin_prefixes)
         SELECT NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10
          WHERE NOT EXISTS (SELECT 1 FROM offers WHERE bank_name = $8 AND restaurant_id IS NULL)`,
        o,
      );
    }
    await c.query(
      `INSERT INTO offers(restaurant_id, kind, value, max_minor, currency, title_en, title_ar, promo_code)
       VALUES ($1,'percent',10,3000,'AED','Welcome 10%','ترحيب 10٪','WELCOME10') ON CONFLICT DO NOTHING`,
      [r.id],
    );

    // Sample plans + subscriptions (managed from the platform console).
    const plan = async (name, price, cur) => (await c.query(
      `INSERT INTO plans(name, price_minor, currency, interval, features)
       SELECT $1,$2,$3,'month','["QR pay","Split bill","CRM & coupons"]' WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = $1 AND currency = $3)
       RETURNING id`, [name, price, cur])).rows[0]?.id
      ?? (await c.query('SELECT id FROM plans WHERE name = $1 AND currency = $2', [name, cur])).rows[0].id;
    const aed = await plan('Pro', 49900, 'AED');
    const omr = await plan('Pro', 4900, 'OMR');
    for (const [rid, pid] of [[r.id, aed], [r2.id, omr]]) {
      await c.query(
        `INSERT INTO subscriptions(restaurant_id, plan_id, status, current_period_end) VALUES ($1,$2,'active', current_date + 30)
         ON CONFLICT (restaurant_id) DO NOTHING`, [rid, pid],
      );
    }

    const pw = await hashPassword(ownerPassword);
    await c.query(
      `INSERT INTO users(restaurant_id, email, password_hash, role) VALUES ($1,'owner@sahab.example',$2,'owner')
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL`,
      [r.id, pw],
    );
    if (!quiet) {
      console.log('\nSeeded.');
      console.log(`  Diner (AED):  /t/${demoToken}`);
      console.log(`  Diner (OMR):  /t/${omrToken}`);
      console.log(`  Admin:        /admin  owner@sahab.example / ${generated ? ownerPassword : '(from SEED_OWNER_PASSWORD)'}\n`);
    }
    return { demoToken, omrToken, ownerPassword, restaurantId: r.id };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(process.env.DATABASE_URL);
  seed(pool, { ownerPassword: process.env.SEED_OWNER_PASSWORD })
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
