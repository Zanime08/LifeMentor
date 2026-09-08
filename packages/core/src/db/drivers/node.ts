import type { DriverOptions, RunResult, SqlDriver, SqlParam } from '../driver';
import { durabilityPragmas } from '../driver';

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;
type DatabaseSyncInstance = import('node:sqlite').DatabaseSync;

/**
 * Node driver — uses the built-in `node:sqlite` module (no native build step, no dependencies).
 * Used by the backend, the CLI tools and the whole automated test suite.
 *
 * The shipped Windows client uses the Tauri/rusqlite driver and Android uses the Capacitor
 * native driver; both implement exactly this interface, so every repository is portable.
 */
/**
 * Load the built-in SQLite module without a static specifier.
 * `process.getBuiltinModule` is the documented way (Node >= 22.3); the dynamic
 * import keeps older Node 20.11+ builds working. The non-literal specifier stops
 * bundlers from trying to resolve a Node built-in at build time.
 */
async function loadNodeSqlite(): Promise<{ DatabaseSync: DatabaseSyncCtor }> {
  const proc = globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined;
  const builtin = proc?.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor } | undefined;
  if (builtin?.DatabaseSync) return { DatabaseSync: builtin.DatabaseSync };
  const specifier = 'node:sqlite';
  const mod = await import(/* @vite-ignore */ specifier) as { DatabaseSync?: DatabaseSyncCtor };
  if (!mod.DatabaseSync) throw new Error('node:sqlite is unavailable on this Node build (requires Node 20.11+ / 22.5+)');
  return { DatabaseSync: mod.DatabaseSync };
}

export class NodeSqlDriver implements SqlDriver {
  readonly kind = 'node' as const;
  private db: DatabaseSyncInstance | null = null;
  private readonly options: DriverOptions;

  constructor(options: DriverOptions = {}) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  describe(): string {
    return this.options.inMemory ? 'memory:node-sqlite' : `file:${this.options.path ?? 'lifementor.sqlite'}`;
  }

  async open(): Promise<void> {
    if (this.db) return;
    const mod = await loadNodeSqlite();
    const location = this.options.inMemory ? ':memory:' : (this.options.path ?? 'lifementor.sqlite');
    this.db = new mod.DatabaseSync(location);
    for (const pragma of durabilityPragmas(this.options.durability, this.options.busyTimeoutMs)) {
      try { this.db.exec(pragma); } catch { /* pragma unsupported on this build — not fatal */ }
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.db.close();
    this.db = null;
  }

  private handle(): DatabaseSyncInstance {
    if (!this.db) throw new Error('NodeSqlDriver: database is not open');
    return this.db;
  }

  async exec(sql: string): Promise<void> {
    this.handle().exec(sql);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const res = this.handle().prepare(sql).run(...normalize(params));
    return { changes: Number(res.changes ?? 0), lastInsertRowid: Number(res.lastInsertRowid ?? 0) };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.handle().prepare(sql).all(...normalize(params)) as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.handle().prepare(sql).get(...normalize(params)) as T | undefined;
  }

  async pragmaValue(name: string): Promise<unknown> {
    const row = await this.get<Record<string, unknown>>(`PRAGMA ${name}`);
    return row ? Object.values(row)[0] : undefined;
  }

  /** Consistent byte snapshot via SQLite online backup (`VACUUM INTO`). */
  async serialize(): Promise<Uint8Array> {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `lifementor-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    try {
      this.handle().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return new Uint8Array(await fs.readFile(tmp));
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Restore from a byte snapshot. File-backed databases only (the production case). */
  async deserialize(bytes: Uint8Array): Promise<void> {
    if (this.options.inMemory || !this.options.path) {
      throw new Error('NodeSqlDriver.deserialize requires a file-backed database');
    }
    const fs = await import('node:fs/promises');
    const path = this.options.path;
    await this.close();
    const tmp = `${path}.restore-${Date.now()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(path, `${path}.pre-restore`).catch(() => undefined);
    await fs.rename(tmp, path);
    for (const suffix of ['-wal', '-shm']) await fs.rm(`${path}${suffix}`, { force: true }).catch(() => undefined);
    await this.open();
  }
}

function normalize(params: SqlParam[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}
