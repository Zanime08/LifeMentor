import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database as DbType } from '@lifementor/core';
import { Database } from '@lifementor/core';
import { CapacitorSqlDriver, type CapacitorSqlitePlugin } from '../src/platform/capacitor/sql-driver';

/**
 * The Capacitor driver is the Android engine. We cannot run Android in CI, so the
 * plugin is mocked with the EXACT v8 @capacitor-community/sqlite surface (flat,
 * options-object API) backed by a real SQLite engine (node:sqlite) on a real
 * temp file — the same durability model as the platform SQLite on the device.
 *
 * Proves: the open/pragma sequence, migrations, transactions, parameter
 * normalization, and that committed data survives a full re-open (req. 8/94).
 */

type SyncDb = import('node:sqlite').DatabaseSync;

function getDatabaseSync(): new (path: string) => SyncDb {
  const proc = globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined;
  const builtin = proc?.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: new (path: string) => SyncDb } | undefined;
  if (builtin?.DatabaseSync) return builtin.DatabaseSync;
  throw new Error('node:sqlite unavailable');
}

class MockCapacitorSQLite implements CapacitorSqlitePlugin {
  readonly pragmas: string[] = [];
  readonly statements: string[] = [];
  private openSet = new Set<string>();
  private known = new Set<string>();
  private dbs = new Map<string, SyncDb>();

  constructor(private readonly dir: string) {}

  private db(database: string): SyncDb {
    const existing = this.dbs.get(database);
    if (existing) return existing;
    throw new Error(`connection "${database}" is not open`);
  }

  async createConnection(options: { database?: string }): Promise<void> {
    if (!options.database) throw new Error('database required');
    this.known.add(options.database);
  }

  async isDatabase(options: { database?: string }): Promise<{ result?: boolean }> {
    return { result: this.known.has(options.database ?? '') };
  }

  async open(options: { database?: string }): Promise<void> {
    const name = options.database ?? '';
    if (this.dbs.has(name)) return;
    // Real file in a temp dir — exactly like the platform DB file on the device.
    const DatabaseSync = getDatabaseSync();
    const db = new DatabaseSync(join(this.dir, `${name}.sqlite`));
    this.dbs.set(name, db);
    this.openSet.add(name);
  }

  async close(options: { database?: string }): Promise<void> {
    const name = options.database ?? '';
    const db = this.dbs.get(name);
    if (db) db.close();
    this.dbs.delete(name);
    this.openSet.delete(name);
  }

  async execute(options: { database?: string; statements?: string; transaction?: boolean }): Promise<unknown> {
    for (const stmt of (options.statements ?? '').split(';')) {
      const sql = stmt.trim();
      if (!sql) continue;
      this.statements.push(sql);
      if (/^PRAGMA /i.test(sql)) this.pragmas.push(sql);
      this.db(options.database ?? '').exec(`${sql};`);
    }
    return {};
  }

  async run(options: { database?: string; statement?: string; values?: unknown[] }): Promise<{ changes?: { changes?: number; lastId?: number } }> {
    this.statements.push(options.statement ?? '');
    const stmt = this.db(options.database ?? '').prepare(options.statement ?? '');
    const values = (options.values ?? []) as (string | number | bigint | null)[];
    const result = stmt.run(...values);
    return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) } };
  }

  async query(options: { database?: string; statement?: string; values?: unknown[] }): Promise<{ values?: Record<string, unknown>[] }> {
    this.statements.push(options.statement ?? '');
    const stmt = this.db(options.database ?? '').prepare(options.statement ?? '');
    const values = (options.values ?? []) as (string | number | bigint | null)[];
    return { values: stmt.all(...values) as Record<string, unknown>[] };
  }
}

const dir = mkdtempSync(join(tmpdir(), 'lifementor-cap-'));
beforeAll(() => undefined);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DB_NAME = 'lifementor';

function newDriver(plugin: MockCapacitorSQLite): CapacitorSqlDriver {
  return new CapacitorSqlDriver({ path: 'lifementor.sqlite', durability: 'safe', busyTimeoutMs: 5000, plugin });
}

describe('CapacitorSqlDriver (v8 plugin contract, Android engine)', () => {
  it('opens with the durability pragmas (WAL, synchronous, FK, busy timeout)', async () => {
    const plugin = new MockCapacitorSQLite(dir);
    const driver = newDriver(plugin);
    await driver.open();

    expect(plugin.pragmas.some((p) => /journal_mode = WAL/i.test(p))).toBe(true);
    expect(plugin.pragmas.some((p) => /synchronous = NORMAL/i.test(p))).toBe(true);
    expect(plugin.pragmas.some((p) => /foreign_keys = ON/i.test(p))).toBe(true);
    expect(plugin.pragmas.some((p) => /busy_timeout = 5000/i.test(p))).toBe(true);
    // journal_mode must run outside a transaction (the plugin would otherwise no-op it).
    await driver.close();
  });

  it('runs migrations, transactions and parameter normalization', async () => {
    const plugin = new MockCapacitorSQLite(dir);
    const db = await Database.open({ driver: newDriver(plugin) });

    expect(await db.readSchemaVersion()).toBeGreaterThan(0);

    const at = new Date('2026-09-08T10:00:00.000Z');
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO tasks (id, title, status, position, created_at, updated_at)
         VALUES ('cap-1', 'Cap task', 'todo', 0, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
      );
    });

    // Repository-level parameters (typed SqlParam) round-trip through the v8 API.
    await db.run(
      `INSERT INTO memories (id, kind, content, importance, confidence, source, section, entity_type, created_at, updated_at)
       VALUES ('cap-norm', 'fact', ?, ?, 'confirmed', 'user_provided', 'sec', ?, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
      [at.toISOString(), 7n, 1],
    );
    const row = (await db.get<Record<string, unknown>>(`SELECT * FROM memories WHERE id = 'cap-norm'`))!;
    expect(row).toMatchObject({ content: at.toISOString(), importance: 7, section: 'sec' });
    expect(Number(row.entity_type)).toBe(1);

    // Driver-level normalization (defensive: Date→ISO, bool→1/0, bigint→number) —
    // the driver contract documented in sql-driver.ts; cast because SqlParam is the narrower repo type.
    await db.driver.run(
      `INSERT INTO memories (id, kind, content, importance, confidence, source, section, entity_type, created_at, updated_at)
       VALUES ('cap-norm2', 'fact', ?, ?, 'confirmed', 'user_provided', 'sec', ?, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
      [at, 2, true] as unknown as (string | number | bigint | Uint8Array | null)[],
    );
    const row2 = (await db.driver.get<Record<string, unknown>>(`SELECT * FROM memories WHERE id = 'cap-norm2'`))!;
    expect(row2.content).toBe(at.toISOString());
    expect(Number(row2.entity_type)).toBe(1);

    // get() appends LIMIT 1 when absent (single-row contract).
    const limited = plugin.statements.find((s) => /FROM memories WHERE id = 'cap-norm' LIMIT 1/i.test(s));
    expect(limited).toBeDefined();
    await db.close();
  });

  it('committed data survives a full re-open (kill/reboot simulation, req. 94)', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'lifementor-cap-reopen-'));
    try {
      const plugin1 = new MockCapacitorSQLite(dir2);
      {
        const db = await Database.open({ driver: newDriver(plugin1) });
        await db.run(
          `INSERT INTO memories (id, kind, content, importance, confidence, source, created_at, updated_at)
           VALUES ('m-1', 'fact', 'capacitor survives', 0.8, 'confirmed', 'user_provided', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
        );
        await db.close(); // simulates the app process being killed
      }

      // A brand-new process: new plugin instance, same DB file on "disk".
      const plugin2 = new MockCapacitorSQLite(dir2);
      const db2 = await Database.open({ driver: newDriver(plugin2) });
      const found = await db2.get<{ content: string }>(`SELECT content FROM memories WHERE id = 'm-1'`);
      expect(found?.content).toBe('capacitor survives');
      await db2.close();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('rejects queries before open', async () => {
    const plugin = new MockCapacitorSQLite(dir);
    const driver = newDriver(plugin);
    await expect(driver.all(`SELECT 1`)).rejects.toThrow(/not open/i);
  });
});
