import { afterAll, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { Database, createSqlDriver } from '@lifementor/core';
import type { Database as DbType } from '@lifementor/core';
import { MemoryPersistence, WasmSqlDriver } from '../src/db/drivers/wasm';

/**
 * The WASM driver is what the browser uses (real SQLite in WebAssembly + an image persisted to
 * IndexedDB). This test runs the same engine under Node to prove: migrations apply, transactions
 * are durable (the image is flushed after every COMMIT — req. 8/94), data survives a full
 * re-open (kill/reboot simulation), and integrity checks pass.
 */

const wasmFile = realpathSync(new URL('../../../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url).pathname);

function openDb(persistence: MemoryPersistence): Promise<DbType> {
  const driver = new WasmSqlDriver({ persistence, wasmUrl: wasmFile, inMemory: false, path: 'wasm-test' });
  return Database.open({ driver, autoFlush: true });
}

const closed: { db: DbType }[] = [];
function track(db: DbType): DbType { closed.push({ db }); return db; }
afterAll(async () => { for (const { db } of closed) { try { await db.close(); } catch { /* ignore */ } } });

describe('WasmSqlDriver (browser engine)', () => {
  it('applies all migrations and creates the full schema', async () => {
    const persistence = new MemoryPersistence();
    const db = track(await openDb(persistence));

    const version = await db.readSchemaVersion();
    expect(version).toBeGreaterThan(0);

    const rows = await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    const tables = rows.map((r) => r.name);
    for (const expected of ['account', 'tasks', 'goals', 'projects', 'skills', 'calendar_events', 'conversations', 'memories', 'backups', 'sync_queue', 'sync_conflicts']) {
      expect(tables, `missing table: ${expected}`).toContain(expected);
    }
  });

  it('is durable across a re-open (committed data survives a restart)', async () => {
    const persistence = new MemoryPersistence();

    // Session 1: write a task and a memory inside a transaction, then close.
    {
      const db = track(await openDb(persistence));
      const task = await db.transaction(async (tx) => {
        const r = await tx.run(
          `INSERT INTO tasks (id, title, status, position, created_at, updated_at) VALUES ('task-w1', 'WASM task', 'todo', 0, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
        );
        await tx.run(
          `INSERT INTO memories (id, kind, content, source, confidence, importance, created_at, updated_at) VALUES ('mem-w1', 'fact', 'WASM memory', 'user_provided', 'confirmed', 0.9, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
        );
        return r;
      });
      expect(task.changes).toBe(1);
      await db.close();
    }

    // Session 2: a brand-new driver over the same persistence backend must see the rows.
    {
      const db = track(await openDb(persistence));
      const task = await db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = 'task-w1'`);
      expect(task?.title).toBe('WASM task');
      const memory = await db.get<{ content: string }>(`SELECT content FROM memories WHERE id = 'mem-w1'`);
      expect(memory?.content).toBe('WASM memory');
      const count = await db.count('tasks', '1=1');
      expect(count).toBe(1);
    }
  });

  it('rolls back uncommitted work on error', async () => {
    const persistence = new MemoryPersistence();
    const db = track(await openDb(persistence));

    const before = await db.count('tasks', '1=1');
    await expect(
      db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO tasks (id, title, status, position, created_at, updated_at) VALUES ('task-rb', 'Rollback task', 'todo', 0, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
        );
        throw new Error('simulate crash mid-transaction');
      }),
    ).rejects.toThrow('simulate crash mid-transaction');

    const after = await db.count('tasks', '1=1');
    expect(after).toBe(before);
    const rolled = await db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = 'task-rb'`);
    expect(rolled).toBeUndefined();
  });

  it('passes integrity checks after writes', async () => {
    const persistence = new MemoryPersistence();
    const db = track(await openDb(persistence));

    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO tasks (id, title, status, position, created_at, updated_at) VALUES ('task-i1', 'Integrity task', 'todo', 0, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
      );
    });

    const report = await db.integrityCheck();
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(report.expectedSchemaVersion);
    expect(report.schemaVersion).toBeGreaterThan(0);
  });

  it('createSqlDriver resolves the wasm kind with a persistence backend', async () => {
    const persistence = new MemoryPersistence();
    const driver = await createSqlDriver({ kind: 'wasm', persistence, wasmUrl: wasmFile, inMemory: false });
    expect(driver.kind).toBe('wasm');
    expect(driver).toBeInstanceOf(WasmSqlDriver);
  });
});
