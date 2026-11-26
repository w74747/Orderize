// Targeted coupons. Audiences are always limited to diners who actually paid at this
// restaurant: a restaurant can never reach diners of other restaurants.

const VISITORS = `
  SELECT p.customer_id, count(DISTINCT date(p.captured_at))::int AS visits, max(p.captured_at) AS last_visit
    FROM payments p JOIN customers c ON c.id = p.customer_id
   WHERE p.restaurant_id = $1 AND p.status = 'captured' AND c.deleted_at IS NULL
   GROUP BY p.customer_id`;

const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/** Issues coupons for one campaign. Returns the customer ids that received a new coupon. */
export async function issueCampaign(pool, campaign, { now = new Date() } = {}) {
  const params = [campaign.restaurant_id, campaign.id, campaign.valid_days];
  let where = 'TRUE';
  let issueKey = `'once'`;
  if (campaign.audience === 'frequent') {
    params.push(campaign.audience_param ?? 3);
    where = `v.visits >= $${params.length}`;
  } else if (campaign.audience === 'lapsed') {
    params.push(campaign.audience_param ?? 30);
    where = `v.last_visit < now() - make_interval(days => $${params.length})`;
  } else if (campaign.audience === 'birthday') {
    const from = mmdd(now);
    const to = mmdd(new Date(now.getTime() + (campaign.audience_param ?? 7) * 864e5));
    params.push(from, to);
    const a = `$${params.length - 1}`, b = `$${params.length}`;
    where = `c.birth_date IS NOT NULL AND (CASE WHEN ${a} <= ${b}
               THEN to_char(c.birth_date, 'MMDD') BETWEEN ${a} AND ${b}
               ELSE to_char(c.birth_date, 'MMDD') >= ${a} OR to_char(c.birth_date, 'MMDD') <= ${b} END)`;
    issueKey = `'bday-' || to_char(now(), 'YYYY')`; // one birthday coupon per year
  }
  const { rows } = await pool.query(
    `INSERT INTO coupons(campaign_id, restaurant_id, customer_id, issue_key, valid_until)
     SELECT $2, $1, v.customer_id, ${issueKey}, now() + make_interval(days => $3)
       FROM (${VISITORS}) v JOIN customers c ON c.id = v.customer_id
      WHERE ${where}
     ON CONFLICT (campaign_id, customer_id, issue_key) DO NOTHING
     RETURNING customer_id`,
    params,
  );
  return rows.map((r) => r.customer_id);
}

/** Sends a WhatsApp notice to opted-in recipients. Best effort, never blocks the request. */
export async function notifyCoupon(ctx, restaurant, campaign, customerIds) {
  if (!customerIds.length || !ctx.config.WHATSAPP_COUPON_TEMPLATE) return;
  const { rows } = await ctx.pool.query(
    `SELECT phone_e164 FROM customers WHERE id = ANY($1) AND marketing_consent AND deleted_at IS NULL AND phone_e164 IS NOT NULL`,
    [customerIds],
  );
  for (const r of rows.slice(0, 1000)) {
    await ctx.whatsapp.sendCoupon(r.phone_e164, { restaurant: restaurant.name_ar || restaurant.name_en, title: campaign.name });
  }
}

/** Daily: birthday campaigns issue coupons automatically. */
export async function runBirthdayCampaigns(ctx) {
  const { rows } = await ctx.pool.query(
    `SELECT c.*, r.name_en, r.name_ar FROM campaigns c JOIN restaurants r ON r.id = c.restaurant_id
      WHERE c.audience = 'birthday' AND c.active AND r.active`,
  );
  let issued = 0;
  for (const c of rows) {
    const ids = await issueCampaign(ctx.pool, c);
    issued += ids.length;
    notifyCoupon(ctx, c, c, ids).catch((e) => ctx.log.warn(e));
  }
  return issued;
}

export async function customerStats(pool, restaurantId) {
  const [kpi, buckets, top, ratings] = await Promise.all([
    pool.query(
      `WITH v AS (${VISITORS}),
            first AS (SELECT p.customer_id, min(p.captured_at) AS first_visit FROM payments p JOIN customers c ON c.id = p.customer_id
                       WHERE p.restaurant_id = $1 AND p.status = 'captured' AND c.deleted_at IS NULL GROUP BY 1),
            spend AS (SELECT count(*)::int AS n, coalesce(avg(share_minor),0)::bigint AS avg_ticket FROM payments
                       WHERE restaurant_id = $1 AND status = 'captured' AND customer_id IS NOT NULL)
       SELECT (SELECT count(*) FROM v)::int AS customers,
              (SELECT count(*) FROM first WHERE first_visit > now() - interval '30 days')::int AS new_30d,
              (SELECT count(*) FROM v WHERE visits >= 2)::int AS returning,
              (SELECT coalesce(round(avg(visits)::numeric, 2), 0) FROM v) AS avg_visits,
              (SELECT avg_ticket FROM spend) AS avg_ticket_minor,
              (SELECT count(*) FROM v WHERE last_visit > now() - interval '30 days')::int AS active_30d`,
      [restaurantId],
    ),
    pool.query(
      `WITH v AS (${VISITORS})
       SELECT CASE WHEN visits = 1 THEN '1' WHEN visits <= 3 THEN '2-3' WHEN visits <= 9 THEN '4-9' ELSE '10+' END AS bucket,
              count(*)::int AS customers
         FROM v GROUP BY 1 ORDER BY min(visits)`,
      [restaurantId],
    ),
    pool.query(
      `WITH v AS (${VISITORS})
       SELECT c.id, c.name, c.phone_e164, c.gender, to_char(c.birth_date, 'MM-DD') AS birthday, v.visits, v.last_visit,
              (SELECT coalesce(sum(share_minor),0) FROM payments WHERE restaurant_id = $1 AND customer_id = c.id AND status = 'captured')::bigint AS spend_minor,
              (SELECT coalesce(sum(points),0) FROM loyalty_ledger WHERE restaurant_id = $1 AND customer_id = c.id)::int AS points
         FROM v JOIN customers c ON c.id = v.customer_id
        ORDER BY v.visits DESC, spend_minor DESC LIMIT 100`,
      [restaurantId],
    ),
    pool.query(
      `SELECT coalesce(round(avg(stars)::numeric, 2), 0) AS avg_30d, count(*)::int AS count_30d
         FROM ratings WHERE restaurant_id = $1 AND created_at > now() - interval '30 days'`,
      [restaurantId],
    ),
  ]);
  return { kpi: { ...kpi.rows[0], rating: ratings.rows[0] }, buckets: buckets.rows, top: top.rows };
}
