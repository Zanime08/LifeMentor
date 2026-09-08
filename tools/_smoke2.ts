import { createSqlDriver } from '../packages/core/src/db/create-driver';
import { MemoryPersistence } from '../packages/core/src/db/drivers/wasm';
const d = await createSqlDriver({ kind: 'wasm', persistence: new MemoryPersistence() });
await d.open();
console.log('foreign_keys =', await d.pragmaValue('foreign_keys'));
await d.exec('CREATE TABLE a(id TEXT PRIMARY KEY)');
await d.exec('CREATE TABLE b(id TEXT PRIMARY KEY, a_id TEXT REFERENCES a(id))');
try { await d.run("INSERT INTO b VALUES('1','nope')"); console.log('not enforced'); } catch (e) { console.log('enforced:', (e as Error).message); }
console.log('after tx-less run, foreign_keys =', await d.pragmaValue('foreign_keys'));
await d.exec('BEGIN IMMEDIATE');
console.log('inside tx, foreign_keys =', await d.pragmaValue('foreign_keys'));
await d.exec('COMMIT');
