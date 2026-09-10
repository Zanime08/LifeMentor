import { AppError } from '../util/result';
import { createLogger } from '../util/logging';
import { nowIso } from '../util/time';
import type { RunResult, SqlDriver, SqlParam } from './driver';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, type Migration, type MigrationContext } from './migrations';

export interface DatabaseOptions {
  driver: SqlDriver;
  /** Take a byte snapshot before applying migrations (crash-safe upgrades). */
  onBeforeMigrate?: (db: Database) => Promise<void>;
  /** Called after every committed transaction (used by the WASM driver to persist). */
  autoFlush?: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  quickCheck: string;
  foreignKeyViolations: { table: string; rowid: number | string; parent: number | string; fkid: number | string }[];
  journalMode: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  checkedAt: string;
}

/**
 * The single entry point to persistence.
 *
 * Responsibilities:
 *  - apply migrations in one transaction each (with a pre-migration backup hook),
 *  - provide nested transactions (savepoints) so services can compose safely,
 *  - guarantee durability: after a committed transaction nothing can be lost (req. 8/9/94),
 *  - run integrity/foreign-key checks used by startup recovery and the CLI.
 */
export class Database {
  readonly driver: SqlDriver;
  private readonly log = createLogger('db');
  private depth = 0;
  private savepointSeq = 0;
  /** Tail of the serialisation queue used by `runExclusive()`. */
  private tail: Promise<void> = Promise.resolve();
  private schemaVersion = 0;

  constructor(private readonly options: DatabaseOptions) {
    this.driver = options.driver;
  }

  static async open(options: DatabaseOptions): Promise<Database> {
    const db = new Database(options);
    if (!db.driver.isOpen) await db.driver.open();
    await db.migrate();
    return db;
  }

  get isOpen(): boolean { return this.driver.isOpen; }
  get location(): string { return this.driver.describe(); }
  get version(): number { return this.schemaVersion; }

  // ───────────────────────────── primitives ─────────────────────────────
  async exec(sql: string): Promise<void> { await this.driver.exec(sql); }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    return this.driver.run(sql, params);
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.driver.all<T>(sql, params);
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.driver.get<T>(sql, params);
  }

  async scalar<T = unknown>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const row = await this.get<Record<string, unknown>>(sql, params);
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  async count(table: string, where = '1=1', params: SqlParam[] = []): Promise<number> {
    const value = await this.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, params);
    return Number(value ?? 0);
  }

  // ───────────────────────────── transactions ─────────────────────────────
  /**
   * Run `fn` inside a transaction. Nested calls from the *same* operation use SAVEPOINTs and
   * only the outermost COMMIT hits the disk. On the WASM driver the image is flushed after the
   * outer commit so "committed" really means durable (req. 8).
   *
   * Concurrency contract (req. 8, 9, 96): independent operations must not run transactions at
   * the same time. A nested call joins the owner's transaction, so a failure in the owner would
   * roll back a sibling's already-acknowledged writes. Use `runExclusive()` — or a service-level
   * lock — to serialise work that can be triggered from several places at once (the dashboard,
   * the mentor and the Today screen all ask for a day plan).
   */
  async transaction<T>(fn: (db: Database) => Promise<T> | T, label = 'tx'): Promise<T> {
    if (this.depth === 0) {
      // Claim the connection *synchronously*, before the first await: two callers arriving in the
      // same tick used to both observe depth 0 and both issue BEGIN, which SQLite rejects with
      // "cannot start a transaction within a transaction".
      this.depth = 1;
      try {
        await this.driver.exec('BEGIN IMMEDIATE');
        const result = await fn(this);
        await this.driver.exec('COMMIT');
        this.depth = 0;
        await this.persistAfterCommit();
        return result;
      } catch (error) {
        this.depth = 0;
        await this.safeRollback();
        this.log.error('transaction failed', { label, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    const name = `sp_${++this.savepointSeq}`;
    await this.driver.exec(`SAVEPOINT ${name}`);
    this.depth += 1;
    try {
      const result = await fn(this);
      await this.driver.exec(`RELEASE SAVEPOINT ${name}`);
      this.depth -= 1;
      return result;
    } catch (error) {
      this.depth -= 1;
      try { await this.driver.exec(`ROLLBACK TO SAVEPOINT ${name}`); await this.driver.exec(`RELEASE SAVEPOINT ${name}`); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Serialise a composite operation (req. 8/9): calls run one after another in call order, and a
   * failure never blocks the queue. The planner uses this because it is invoked from several
   * screens and from the AI tools at the same time, and its work spans a whole transaction.
   */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(() => fn(), () => fn());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async persistAfterCommit(): Promise<void> {
    if (this.options.autoFlush === false) return;
    const flush = (this.driver as unknown as { flush?: () => Promise<void> }).flush;
    if (typeof flush === 'function') await flush.call(this.driver);
  }

  private async safeRollback(): Promise<void> {
    try { await this.driver.exec('ROLLBACK'); } catch { /* already rolled back */ }
  }

  // ───────────────────────────── migrations ─────────────────────────────
  async readSchemaVersion(): Promise<number> {
    const ensure = `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    await this.driver.exec(ensure);
    const row = await this.get<{ value: string }>(`SELECT value FROM schema_meta WHERE key = 'schema_version'`);
    if (row) return Number(row.value);
    const fromPragma = Number((await this.driver.pragmaValue('user_version')) ?? 0);
    return Number.isFinite(fromPragma) ? fromPragma : 0;
  }

  async migrate(): Promise<{ from: number; to: number; applied: Migration[] }> {
    const from = await this.readSchemaVersion();
    if (from > CURRENT_SCHEMA_VERSION) {
      throw new AppError('unsupported', `Database schema v${from} is newer than this build (v${CURRENT_SCHEMA_VERSION})`, {
        userMessage: 'This data was created by a newer version of LifeMentor. Please update the app to open it.',
      });
    }
    const pending = MIGRATIONS.filter((m) => m.version > from);
    if (pending.length === 0) {
      this.schemaVersion = from;
      return { from, to: from, applied: [] };
    }
    await this.options.onBeforeMigrate?.(this);

    for (const migration of pending) {
      this.log.info('applying migration', { version: migration.version, name: migration.name });
      await this.driver.exec('BEGIN IMMEDIATE');
      try {
        await this.driver.exec(migration.sql);
        if (migration.up) {
          const ctx: MigrationContext = {
            exec: (sql) => this.driver.exec(sql),
            run: async (sql, params = []) => this.driver.run(sql, params as SqlParam[]),
            all: <T,>(sql: string, params: unknown[] = []) => this.driver.all<T>(sql, params as SqlParam[]),
          };
          await migration.up(ctx);
        }
        await this.driver.run(
          `INSERT INTO schema_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [String(migration.version), nowIso()],
        );
        await this.driver.exec(`PRAGMA user_version = ${migration.version}`);
        await this.driver.exec('COMMIT');
      } catch (error) {
        await this.safeRollback();
        this.log.error('migration failed', { version: migration.version, error: error instanceof Error ? error.message : String(error) });
        throw new AppError('storage', `Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`, {
          userMessage: 'The database upgrade failed. Your previous data was backed up and can be restored from Settings → Data.',
          details: { version: migration.version, name: migration.name },
        });
      }
      this.schemaVersion = migration.version;
    }
    await this.persistAfterCommit();
    return { from, to: this.schemaVersion, applied: pending };
  }

  // ───────────────────────────── health ─────────────────────────────
  async integrityCheck(options: { full?: boolean } = {}): Promise<IntegrityReport> {
    const quickCheck = String((await this.driver.pragmaValue(options.full ? 'integrity_check' : 'quick_check')) ?? 'unknown');
    const fkRows = await this.all<{ table: string; rowid: number | string; parent: number | string; fkid: number | string }>('PRAGMA foreign_key_check');
    const journalMode = String((await this.driver.pragmaValue('journal_mode')) ?? 'unknown');
    const schemaVersion = await this.readSchemaVersion();
    return {
      ok: quickCheck === 'ok' && fkRows.length === 0,
      quickCheck,
      foreignKeyViolations: fkRows,
      journalMode,
      schemaVersion,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      checkedAt: nowIso(),
    };
  }

  async checkpoint(): Promise<void> {
    try { await this.driver.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not all drivers support it */ }
  }

  async snapshotBytes(): Promise<Uint8Array | null> {
    return this.driver.serialize ? this.driver.serialize() : null;
  }

  async close(): Promise<void> {
    await this.persistAfterCommit();
    await this.driver.close();
  }
}
