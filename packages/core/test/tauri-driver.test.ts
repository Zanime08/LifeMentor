import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database as DbType } from '@lifementor/core';
import { Database } from '@lifementor/core';
import { TauriSqlDriver, type TauriInvoke } from '../src/platform/tauri/sql-driver';

/**
 * The Tauri driver is the Windows engine (rusqlite on the Rust side). Rust cannot run in CI,
 * so this test emulates the Rust side with node:sqlite and implements the EXACT `sql_*`
 * invoke contract that `apps/desktop/src-tauri/src/db.rs` must satisfy — argument names,
 * result shapes (`{ changes, lastInsertRowid }`, rows as objects, pragma scalars), and the
 * backup/restore byte flow. Any drift between the JS driver and the Rust commands breaks here.
 */
type SyncDb = import('node:sqlite').DatabaseSync;

function getDatabaseSync(): { DatabaseSync: new (path: string) => SyncDb } {
  const proc = globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined;
  const builtin = proc?.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: new (path: string) => SyncDb } | undefined;
  if (builtin?.DatabaseSync) return { DatabaseSync: builtin.DatabaseSync };
  throw new Error('node:sqlite unavailable');
}

function makeRustEmulator(path: string): { invoke: TauriInvoke; engine: () => SyncDb | null } {
  let db: SyncDb | null = null;
  const { DatabaseSync } = getDatabaseSync();

  const invoke: TauriInvoke = async (command, args = {}) => {
    switch (command) {
      case 'sql_open': {
        // Mirrors db.rs::sql_open (parent dir created + WAL + durability profile + FK + busy timeout).
        const durability = String(args.durability ?? 'safe');
        const busy = Number(args.busyTimeoutMs ?? 5000);
        const target = String(args.path);
        const parent = target.slice(0, target.lastIndexOf('/'));
        if (parent) mkdirSync(parent, { recursive: true });
        db = new DatabaseSync(target);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(`PRAGMA synchronous = ${durability === 'paranoid' ? 'FULL' : durability === 'fast' ? 'OFF' : 'NORMAL'};`);
        db.exec('PRAGMA foreign_keys = ON;');
        db.exec(`PRAGMA busy_timeout = ${busy};`);
        return null;
      }
      case 'sql_close':
        db?.close();
        db = null;
        return null;
      case 'sql_exec': {
        db!.exec(String(args.sql));
        return null;
      }
      case 'sql_run': {
        const stmt = db!.prepare(String(args.sql));
        const result = stmt.run(...((args.params as (string | number | bigint | null)[]) ?? []));
        // Mirrors db.rs: camelCase JSON keys — TauriSqlDriver reads exactly these.
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      }
      case 'sql_all': {
        const stmt = db!.prepare(String(args.sql));
        return stmt.all(...((args.params as (string | number | bigint | null)[]) ?? [])) as Record<string, unknown>[];
      }
      case 'sql_get': {
        const stmt = db!.prepare(String(args.sql));
        return (stmt.all(...((args.params as (string | number | bigint | null)[]) ?? [])) as Record<string, unknown>[])?.[0] ?? null;
      }
      case 'sql_pragma': {
        const name = String(args.name);
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid pragma name');
        const row = db!.prepare(`PRAGMA ${name};`).get() as Record<string, unknown>;
        return row ? Object.values(row)[0] : null;
      }
      case 'sql_backup_bytes': {
        // Mirrors db.rs: TRUNCATE the WAL, then read the main file as raw bytes.
        db!.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        const bytes = readFileSync(path);
        return Uint8Array.from(bytes) as unknown as number[]; // real Rust sends raw bytes; Uint8Array.from handles both
      }
      case 'sql_restore_bytes': {
        // Mirrors db.rs: close, replace the file (+ sidecars), reopen.
        const bytes = args.bytes as number[];
        if (bytes.length < 100) throw new Error('refusing to restore: snapshot is too small to be a SQLite file');
        db?.close();
        db = null;
        writeFileSync(path, Uint8Array.from(bytes));
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${path}${suffix}`;
          if (existsSync(sidecar)) unlinkSync(sidecar);
        }
        db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys = ON;');
        db.exec('PRAGMA busy_timeout = 5000;');
        return null;
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  };
  return { invoke, engine: () => db };
}

const dir = mkdtempSync(join(tmpdir(), 'lifementor-tauri-'));
const DB_PATH = join(dir, 'data', 'lifementor.sqlite');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newDriver(invoke: TauriInvoke): TauriSqlDriver {
  return new TauriSqlDriver({ path: DB_PATH, durability: 'safe', busyTimeoutMs: 5000, invoke });
}

describe('TauriSqlDriver (rusqlite invoke contract, Windows engine)', () => {
  it('opens with the durability profile (WAL + synchronous NORMAL)', async () => {
    const { invoke } = makeRustEmulator(DB_PATH);
    const driver = newDriver(invoke);
    await driver.open();

    expect(await driver.pragmaValue('journal_mode')).toBe('wal');
    // synchronous: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    expect(await driver.pragmaValue('synchronous')).toBe(1);
    expect(await driver.pragmaValue('foreign_keys')).toBe(1);
    await driver.close();
  });

  it('runs migrations and transactions through the sql_* contract', async () => {
    const { invoke } = makeRustEmulator(DB_PATH);
    const db = await Database.open({ driver: newDriver(invoke) });
    expect(await db.readSchemaVersion()).toBeGreaterThan(0);

    await db.transaction(async (tx) => {
      const r = await tx.run(
        `INSERT INTO tasks (id, title, status, position, created_at, updated_at)
         VALUES ('tauri-1', 'Tauri task', 'todo', 0, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
      );
      expect(r.changes).toBe(1);
    });

    const found = await db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = 'tauri-1'`);
    expect(found?.title).toBe('Tauri task');
    await db.close();
  });

  it('backup/restore round-trip (serialize → restore → data intact, req. 8/56)', async () => {
    const emu = makeRustEmulator(DB_PATH);
    const db = await Database.open({ driver: newDriver(emu.invoke) });

    await db.run(
      `INSERT INTO memories (id, kind, content, importance, confidence, source, created_at, updated_at)
       VALUES ('tauri-m1', 'fact', 'backup roundtrip', 0.7, 'confirmed', 'user_provided', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')`,
    );
    const bytes = await db.driver.serialize!();
    expect(bytes.byteLength).toBeGreaterThan(100);

    // Destroy current state, then restore from the snapshot.
    await db.run(`DELETE FROM memories WHERE id = 'tauri-m1'`);
    expect(await db.get(`SELECT 1 AS x FROM memories WHERE id = 'tauri-m1'`)).toBeUndefined();

    await db.driver.deserialize!(bytes);
    const restored = await db.get<{ content: string }>(`SELECT content FROM memories WHERE id = 'tauri-m1'`);
    expect(restored?.content).toBe('backup roundtrip');
    await db.close();
  });

  it('data survives a full process re-open (req. 94)', async () => {
    // Session 1 already left data in DB_PATH (from the previous tests). A fresh emulator = new process.
    const { invoke } = makeRustEmulator(DB_PATH);
    const db = await Database.open({ driver: newDriver(invoke) });
    const task = await db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = 'tauri-1'`);
    expect(task?.title).toBe('Tauri task');
    await db.close();
  });
});
