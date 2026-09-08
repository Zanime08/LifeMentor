/**
 * Platform-independent SQL driver contract.
 *
 * Implementations:
 *  - node       → node:sqlite (server, CLI, tests)              packages/core/src/db/drivers/node.ts
 *  - wasm       → sql.js (browser dev preview + web tests)      packages/core/src/db/drivers/wasm.ts
 *  - tauri      → Rust rusqlite commands (Windows client)       packages/core/src/platform/tauri
 *  - capacitor  → @capacitor-community/sqlite (Android client)  packages/core/src/platform/capacitor
 *
 * Everything is async so the same repositories/services run unchanged on a native bridge.
 */

export type SqlParam = string | number | bigint | Uint8Array | null;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlDriver {
  readonly kind: 'node' | 'wasm' | 'tauri' | 'capacitor';
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Multi-statement SQL without parameters (DDL, migrations, pragmas). */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParam[]): Promise<RunResult>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  /** Raw scalar pragma read, e.g. `pragmaValue('journal_mode')`. */
  pragmaValue(name: string): Promise<unknown>;
  /** Byte-level snapshot of the database (backups / export / integrity tools). */
  serialize?(): Promise<Uint8Array>;
  /** Restore from a byte snapshot (used by backup restore in wasm/mobile drivers). */
  deserialize?(bytes: Uint8Array): Promise<void>;
  /** Location description for diagnostics ("file:/path" | "memory" | "opfs:lifementor.sqlite"). */
  describe(): string;
}

export interface DriverOptions {
  /** Absolute path (node/tauri/capacitor) or logical name (wasm). */
  path?: string;
  /** Run entirely in memory (tests, ephemeral sessions). */
  inMemory?: boolean;
  /** Crash-safety profile. `safe` = WAL + synchronous NORMAL (default). */
  durability?: 'safe' | 'paranoid' | 'fast';
  busyTimeoutMs?: number;
}

/** Pragmas applied to every connection at open time (docs/03 §1). */
export function durabilityPragmas(durability: DriverOptions['durability'] = 'safe', busyTimeoutMs = 5000): string[] {
  const synchronous = durability === 'paranoid' ? 'FULL' : durability === 'fast' ? 'OFF' : 'NORMAL';
  return [
    'PRAGMA journal_mode = WAL',
    `PRAGMA synchronous = ${synchronous}`,
    'PRAGMA foreign_keys = ON',
    `PRAGMA busy_timeout = ${busyTimeoutMs}`,
    'PRAGMA wal_autocheckpoint = 1000',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA cache_size = -8000',
  ];
}
