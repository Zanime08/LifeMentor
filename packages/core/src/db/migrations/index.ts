import { MIGRATION_0001 } from './0001_init';

export interface Migration {
  /** Monotonic integer, also written to `PRAGMA user_version` and `schema_meta.schema_version`. */
  version: number;
  name: string;
  sql: string;
  /** Optional data migration executed after the DDL, inside the same transaction. */
  up?: (ctx: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: MIGRATION_0001 },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
