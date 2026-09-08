import { Database } from '../packages/core/src/db/database';
import { createSqlDriver } from '../packages/core/src/db/create-driver';
import { MemoryPersistence } from '../packages/core/src/db/drivers/wasm';

for (const kind of ['node', 'wasm'] as const) {
  const driver = await createSqlDriver({ kind, inMemory: kind === 'node', persistence: kind === 'wasm' ? new MemoryPersistence() : undefined });
  const db = await Database.open({ driver });
  const tables = await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const indexes = await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`);
  const integrity = await db.integrityCheck({ full: true });
  console.log(`[${kind}] ${driver.describe()} tables=${tables.length} indexes=${indexes.length} schemaVersion=${integrity.schemaVersion} ok=${integrity.ok} journal=${integrity.journalMode}`);
  // transaction + rollback smoke
  await db.transaction(async (t) => { await t.run(`INSERT INTO settings (key,value,category,updated_at) VALUES ('k','v','general',?)`, [new Date().toISOString()]); });
  const row = await db.get(`SELECT * FROM settings WHERE key='k'`);
  console.log(`[${kind}] tx insert ->`, row);
  try {
    await db.transaction(async (t) => { await t.run(`INSERT INTO settings (key,value,category,updated_at) VALUES ('k2','v','general','x')`); throw new Error('boom'); });
  } catch (e) { console.log(`[${kind}] rollback ok:`, (e as Error).message, await db.count('settings', `key='k2'`)); }
  // FK enforcement
  try { await db.run(`INSERT INTO tasks (id,title,goal_id,created_at,updated_at) VALUES ('t1','x','missing-goal','a','b')`); console.log(`[${kind}] FK NOT enforced (!)`); }
  catch (e) { console.log(`[${kind}] FK enforced:`, (e as Error).message.slice(0, 60)); }
  await db.close();
}
console.log('SMOKE OK');
