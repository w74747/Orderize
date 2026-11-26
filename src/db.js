import pg from 'pg';

// BIGINT -> JS number. Safe: amounts are bounded far below 2^53 by validation.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint out of safe range');
  return n;
});

// DATE -> 'YYYY-MM-DD' string. Converting to a JS Date would shift it by the server's timezone.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url) {
  const ssl =
    /sslmode=require/.test(url) || process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined;
  return new pg.Pool({
    connectionString: url,
    ssl,
    max: 10,
    statement_timeout: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

/** Run fn inside a transaction. Rolls back on any throw. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
