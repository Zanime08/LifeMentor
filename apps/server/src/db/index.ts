import { createSqlDriver } from '@lifementor/core';
import type { SqlDriver, SqlParam } from '@lifementor/core';
import { SERVER_SCHEMA_SQL, SERVER_SCHEMA_VERSION } from './schema';

/**
 * The server's own SQLite database.
 *
 * It reuses the core driver (WAL, `synchronous=FULL`-capable, foreign keys on) but has its own
 * schema: the server never stores the client's entity tables, only accounts, sessions, devices,
 * the opaque sync feed, AI usage and the audit log.
 */
export class ServerDb {
  private constructor(private readonly driver: SqlDriver) {}

  static async open(options: { path?: string; inMemory?: boolean; durability?: 'safe' | 'paranoid' | 'fast' } = {}): Promise<ServerDb> {
    const driver = await createSqlDriver({
      kind: 'node',
      path: options.inMemory ? undefined : options.path,
      inMemory: options.inMemory ?? false,
      durability: options.durability ?? 'paranoid',
    });
    await driver.open();
    const db = new ServerDb(driver);
    await db.migrate();
    return db;
  }

  private async migrate(): Promise<void> {
    await this.driver.exec(SERVER_SCHEMA_SQL);
    const current = await this.driver.pragmaValue('user_version');
    if (Number(current ?? 0) < SERVER_SCHEMA_VERSION) {
      await this.driver.exec(`PRAGMA user_version = ${SERVER_SCHEMA_VERSION}`);
    }
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.driver.all<T>(sql, params);
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.driver.get<T>(sql, params);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    return this.driver.run(sql, params);
  }

  async exec(sql: string): Promise<void> {
    return this.driver.exec(sql);
  }

  /** All statements run inside one transaction; a throw rolls everything back. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.driver.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      await this.driver.exec('COMMIT');
      return result;
    } catch (error) {
      await this.driver.exec('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** `PRAGMA user_version` — aliasing pragma output is not valid SQL, so read it directly. */
  async schemaVersion(): Promise<number> {
    const value = await this.driver.pragmaValue('user_version');
    return Number(value ?? 0);
  }

  async integrityCheck(): Promise<{ ok: boolean; detail: string }> {
    const row = await this.driver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
    const detail = String(row?.integrity_check ?? 'unknown');
    const foreignKeys = await this.driver.all('PRAGMA foreign_key_check');
    return { ok: detail === 'ok' && foreignKeys.length === 0, detail: foreignKeys.length ? `${detail}; ${foreignKeys.length} foreign-key violation(s)` : detail };
  }

  describe(): string { return this.driver.describe(); }

  async close(): Promise<void> {
    if (this.driver.isOpen) await this.driver.close();
  }
}

export { SERVER_SCHEMA_VERSION };
