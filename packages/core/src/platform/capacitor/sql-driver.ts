import type { DriverOptions, RunResult, SqlDriver, SqlParam } from '../../db/driver';

/**
 * Android driver — wraps `@capacitor-community/sqlite`, i.e. the platform SQLite
 * (WAL enabled, real transactions) inside the Capacitor shell (`apps/mobile`).
 *
 * The plugin is resolved lazily so the core package builds and tests without it installed.
 */
interface CapacitorSqliteStatementLike {
  // The plugin returns plain objects for queries; we only need the shapes below.
  values?: Record<string, unknown>[];
  changes?: { changes?: number; last_insert_rowid?: number };
}

interface CapacitorSqliteDb {
  execute(statements: string, transaction?: boolean): Promise<{ changes?: { changes?: number; last_insert_rowid?: number } }>;
  run(statement: string, values?: SqlParam[], transaction?: boolean): Promise<{ changes?: { changes?: number; last_insert_rowid?: number } }>;
  query(statement: string, values?: SqlParam[]): Promise<{ values?: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

interface CapacitorSqlitePlugin {
  createConnection(database: string, encrypted: boolean, mode: string, version: number, encryptedSecret?: string): Promise<CapacitorSqliteDb>;
  retrieveConnection(database: string): Promise<CapacitorSqliteDb>;
  isConnection(database: string): Promise<{ result?: boolean }>;
  closeConnection(database: string): Promise<void>;
  deleteDatabase(database: string): Promise<void>;
}

async function loadPlugin(): Promise<CapacitorSqlitePlugin> {
  try {
    const moduleName = '@capacitor-community/sqlite'; // resolved at runtime inside the Capacitor shell
    const mod = (await import(/* @vite-ignore */ moduleName)) as { CapacitorSQLite?: CapacitorSqlitePlugin };
    if (mod.CapacitorSQLite) return mod.CapacitorSQLite;
  } catch { /* plugin not installed in this runtime */ }
  throw new Error('Capacitor SQLite plugin is not available — the Android shell must provide @capacitor-community/sqlite');
}

export class CapacitorSqlDriver implements SqlDriver {
  readonly kind = 'capacitor' as const;
  private plugin: CapacitorSqlitePlugin | null = null;
  private db: CapacitorSqliteDb | null = null;
  private readonly dbName: string;

  constructor(private readonly options: DriverOptions = {}) {
    this.dbName = options.inMemory ? 'lifementor_test' : (options.path ?? 'lifementor').replace(/\.sqlite$/, '');
  }

  get isOpen(): boolean { return this.db !== null; }

  describe(): string { return `capacitor:${this.dbName}`; }

  async open(): Promise<void> {
    if (this.db) return;
    this.plugin = await loadPlugin();
    const existing = await this.plugin.isConnection(this.dbName);
    this.db = existing.result
      ? await this.plugin.retrieveConnection(this.dbName)
      : await this.plugin.createConnection(this.dbName, false, 'no-encryption', 1);
    // WAL + foreign keys + busy timeout are applied by the plugin/SQLite; assert the ones we need.
    await this.db.execute('PRAGMA foreign_keys = ON;', false);
  }

  async close(): Promise<void> {
    if (!this.db || !this.plugin) return;
    await this.plugin.closeConnection(this.dbName);
    this.db = null;
  }

  private handle(): CapacitorSqliteDb {
    if (!this.db) throw new Error('CapacitorSqlDriver: database is not open');
    return this.db;
  }

  async exec(sql: string): Promise<void> {
    await this.handle().execute(ensureTerminator(sql), false);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const result = await this.handle().run(sql, normalize(params), false);
    return { changes: Number(result?.changes?.changes ?? 0), lastInsertRowid: Number(result?.changes?.last_insert_rowid ?? 0) };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const result: CapacitorSqliteStatementLike = await this.handle().query(sql, normalize(params));
    return ((result?.values ?? []) as T[]);
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(limitOne(sql), params);
    return rows[0];
  }

  async pragmaValue(name: string): Promise<unknown> {
    const rows = await this.all<Record<string, unknown>>(`PRAGMA ${name};`);
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  }

  async serialize(): Promise<Uint8Array> {
    // The Capacitor plugin can copy the database to the app's public directory; the mobile
    // BackupService uses that path and then reads the file through the Filesystem plugin.
    throw new Error('CapacitorSqlDriver.serialize: use BackupService.exportArchive() (JSON) or the plugin copy path');
  }
}

function normalize(params: SqlParam[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}

function ensureTerminator(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function limitOne(sql: string): string {
  return /\blimit\b/i.test(sql) ? sql : `${sql.replace(/;\s*$/, '')} LIMIT 1`;
}
