import type { DriverOptions, RunResult, SqlDriver, SqlParam } from '../../db/driver';
import { durabilityPragmas } from '../../db/driver';

/**
 * Android driver — wraps `@capacitor-community/sqlite` v8 (platform SQLite,
 * WAL enabled, real transactions) inside the Capacitor shell (`apps/mobile`).
 *
 * The v8 plugin exposes a flat, options-object API (`run({database, statement, values})`).
 * The plugin instance is injected by the shell (`options.plugin`) so a Vite-bundled
 * app resolves it deterministically; when omitted the driver falls back to a runtime
 * `import('@capacitor-community/sqlite')` for non-bundled runtimes.
 *
 * Transaction semantics (mirrors the other drivers):
 *  - `exec` runs raw statement batches with `transaction: false` — this is how the
 *    Database layer issues BEGIN IMMEDIATE / COMMIT and the open-time pragmas
 *    (`journal_mode` must run outside a transaction);
 *  - `run` (single statement) keeps the plugin's per-call transaction — every write
 *    is committed to disk immediately (req. 8).
 */

/** Minimal structural view of `@capacitor-community/sqlite` v8 (options-object API). */
export interface CapacitorSqlitePlugin {
  createConnection(options: { database?: string; version?: number; encrypted?: boolean; mode?: string; readonly?: boolean }): Promise<void>;
  isDatabase(options: { database?: string }): Promise<{ result?: boolean }>;
  open(options: { database?: string }): Promise<void>;
  close(options: { database?: string }): Promise<void>;
  execute(options: { database?: string; statements?: string; transaction?: boolean }): Promise<unknown>;
  run(options: { database?: string; statement?: string; values?: unknown[]; transaction?: boolean }): Promise<{ changes?: { changes?: number; lastId?: number | bigint } }>;
  query(options: { database?: string; statement?: string; values?: unknown[] }): Promise<{ values?: Record<string, unknown>[] }>;
}

async function loadPlugin(): Promise<CapacitorSqlitePlugin> {
  try {
    const moduleName = '@capacitor-community/sqlite'; // resolved at runtime inside the Capacitor shell
    const mod = (await import(/* @vite-ignore */ moduleName)) as { CapacitorSQLite?: CapacitorSqlitePlugin };
    if (mod.CapacitorSQLite) return mod.CapacitorSQLite;
  } catch { /* plugin not installed in this runtime */ }
  throw new Error('Capacitor SQLite plugin is not available — the Android shell must provide @capacitor-community/sqlite');
}

export interface CapacitorSqlDriverOptions extends DriverOptions {
  /**
   * Injected `@capacitor-community/sqlite` plugin instance. The Capacitor shell passes its own
   * statically-imported instance so a bundled (Vite) app resolves it deterministically. When
   * omitted the driver falls back to a runtime `import('@capacitor-community/sqlite')`.
   */
  plugin?: CapacitorSqlitePlugin;
}

export class CapacitorSqlDriver implements SqlDriver {
  readonly kind = 'capacitor' as const;
  private plugin: CapacitorSqlitePlugin | null = null;
  private readonly dbName: string;

  constructor(private readonly options: CapacitorSqlDriverOptions = {}) {
    this.dbName = options.inMemory ? 'lifementor_test' : (options.path ?? 'lifementor').replace(/\.sqlite$/, '');
  }

  get isOpen(): boolean { return this.opened; }
  private opened = false;

  describe(): string { return `capacitor:${this.dbName}`; }

  private async handle(): Promise<CapacitorSqlitePlugin> {
    if (!this.opened) throw new Error('CapacitorSqlDriver: database is not open');
    if (!this.plugin) this.plugin = this.options.plugin ?? (await loadPlugin());
    return this.plugin;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const plugin = this.options.plugin ?? (await loadPlugin());
    const existing = await plugin.isDatabase({ database: this.dbName });
    if (!existing.result) {
      await plugin.createConnection({ database: this.dbName, encrypted: false, mode: 'no-encryption', version: 1 });
    }
    await plugin.open({ database: this.dbName });
    // Same pragmas as the node/wasm drivers — WAL, synchronous, FK, busy timeout (docs/03 §1).
    // journal_mode must run outside a transaction → transaction: false.
    for (const pragma of durabilityPragmas(this.options.durability, this.options.busyTimeoutMs)) {
      await plugin.execute({ database: this.dbName, statements: pragma, transaction: false });
    }
    this.plugin = plugin;
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened || !this.plugin) return;
    await this.plugin.close({ database: this.dbName });
    this.opened = false;
  }

  async exec(sql: string): Promise<void> {
    const plugin = await this.handle();
    await plugin.execute({ database: this.dbName, statements: ensureTerminator(sql), transaction: false });
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const plugin = await this.handle();
    const result = await plugin.run({ database: this.dbName, statement: sql, values: normalize(params) });
    return {
      changes: Number(result?.changes?.changes ?? 0),
      lastInsertRowid: Number(result?.changes?.lastId ?? 0),
    };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const plugin = await this.handle();
    const result = await plugin.query({ database: this.dbName, statement: sql, values: normalize(params) });
    return (result?.values ?? []) as T[];
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

function normalize(params: SqlParam[]): unknown[] {
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
