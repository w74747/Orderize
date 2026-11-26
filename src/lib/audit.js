/** Append-only audit trail. Never put secrets, tokens or card data in `meta`. */
export async function audit(db, { actorType, actorId = null, restaurantId = null, action, target = null, ip = null, meta = {} }) {
  await db.query(
    `INSERT INTO audit_log(actor_type, actor_id, restaurant_id, action, target, ip, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorType, actorId, restaurantId, action, target, ip, meta],
  );
}
