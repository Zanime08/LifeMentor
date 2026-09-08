import type { DriverOptions, SqlDriver } from './driver';

export type DriverKind = 'node' | 'wasm' | 'tauri' | 'capacitor';

export interface CreateDriverOptions extends DriverOptions {
  kind: DriverKind;
  /** WASM only: where the SQLite image is durably kept between sessions. */
  persistence?: import('./drivers/wasm').PersistenceBackend;
  /** WASM only: URL (or resolver) of sql-wasm.wasm — set by the bundler in the browser. */
  wasmUrl?: string | (() => string);
}

/**
 * Driver factory. Imports are dynamic so a browser bundle never pulls in `node:sqlite`
 * and a Node bundle never pulls in `sql.js`.
 */
export async function createSqlDriver(options: CreateDriverOptions): Promise<SqlDriver> {
  switch (options.kind) {
    case 'node': {
      const { NodeSqlDriver } = await import('./drivers/node');
      return new NodeSqlDriver(options);
    }
    case 'wasm': {
      const { WasmSqlDriver } = await import('./drivers/wasm');
      return new WasmSqlDriver({ ...options, persistence: options.persistence, wasmUrl: options.wasmUrl });
    }
    case 'tauri': {
      const { TauriSqlDriver } = await import('../platform/tauri/sql-driver');
      return new TauriSqlDriver(options);
    }
    case 'capacitor': {
      const { CapacitorSqlDriver } = await import('../platform/capacitor/sql-driver');
      return new CapacitorSqlDriver(options);
    }
    default:
      throw new Error(`Unknown SQL driver kind: ${String(options.kind)}`);
  }
}

/** Detect the best driver for the current runtime. */
export function detectDriverKind(): DriverKind {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__TAURI_INTERNALS__ !== 'undefined' || typeof g.__TAURI__ !== 'undefined') return 'tauri';
  if (typeof g.Capacitor !== 'undefined') return 'capacitor';
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'wasm';
  return 'node';
}
