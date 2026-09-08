import { Database } from '../packages/core/src/db/database';
import { createSqlDriver } from '../packages/core/src/db/create-driver';
import { MemoryPersistence } from '../packages/core/src/db/drivers/wasm';
const driver = await createSqlDriver({ kind: 'wasm', persistence: new MemoryPersistence() });
const db = await Database.open({ driver });
console.log('fk after migrate =', await driver.pragmaValue('foreign_keys'));
try { await db.run(`INSERT INTO tasks (id,title,goal_id,created_at,updated_at) VALUES ('t1','x','missing','a','b')`); console.log('insert succeeded — not enforced'); }
catch (e) { console.log('enforced:', (e as Error).message); }
await db.transaction(async () => { console.log('fk inside tx =', await driver.pragmaValue('foreign_keys')); });
console.log('fk after tx =', await driver.pragmaValue('foreign_keys'));
