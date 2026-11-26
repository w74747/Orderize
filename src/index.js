import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { buildApp } from './server.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool);
if (process.env.RUN_SEED === 'true') {
  // Demo data only. Never enable on a real production database.
  const { seed } = await import('../scripts/seed.js');
  await seed(pool, { ownerPassword: process.env.SEED_OWNER_PASSWORD });
}
const app = await buildApp({ config, pool });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
