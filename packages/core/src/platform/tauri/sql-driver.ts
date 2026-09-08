import type { DriverOptions, RunResult, SqlDriver, SqlParam } from '../../db/driver';

/**
 * Windows driver — talks to the Rust side of the Tauri shell (`apps/desktop/src-tauri/src/db.rs`),
 * which owns a real rusqlite connection to `%APPDATA%/ai.lifementor.app/data/lifementor.sqlite`
 * with WAL enabled. No WASM, no JSON storage: the same SQLite engine as any native app.
 *
 * The `invoke` function is injected (or discovered) so the core package does not hard-depend
 * on `@tauri-apps/api` and stays testable in Node.
 */
export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

async function discoverInvoke(): Promise<TauriInvoke> {
  const g = globalThis as Record<string, any>;
  if (typeof g.__TAURI_INTERNALS__?.invoke === 'function') return g.__TAURI_INTERNALS__.invoke as TauriInvoke;
  if (typeof g.__TAURI__?.core?.invoke === 'function') return g.__TAURI__.core.invoke as TauriInvoke;
  try {
    const moduleName = '@tauri-apps/api/core'; // resolved at runtime inside the Tauri shell
    const mod = (await import(/* @vite-ignore */ moduleName)) as { invoke?: TauriInvoke };
    if (mod.invoke) return mod.invoke;
  } catch { /* not running inside Tauri */ }
  throw new Error('Tauri runtime is not available — the Windows shell must be running');
}

export class TauriSqlDriver implements SqlDriver {
  readonly kind = 'tauri' as const;
  private invoke: TauriInvoke | null;
  private opened = false;

  constructor(private readonly options: DriverOptions & { invoke?: TauriInvoke } = {}) {
    this.invoke = options.invoke ?? null;
  }

  get isOpen(): boolean { return this.opened; }

  describe(): string {
    return `tauri:${this.options.inMemory ? 'memory' : this.options.path ?? 'lifementor.sqlite'}`;
  }

  private async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.invoke) this.invoke = await discoverInvoke();
    return (await this.invoke(command, args)) as T;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.call('sql_open', {
      path: this.options.inMemory ? ':memory:' : (this.options.path ?? 'lifementor.sqlite'),
      durability: this.options.durability ?? 'safe',
      busyTimeoutMs: this.options.busyTimeoutMs ?? 5000,
    });
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    await this.call('sql_close');
    this.opened = false;
  }

  async exec(sql: string): Promise<void> {
    await this.call('sql_exec', { sql });
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const result = await this.call<{ changes: number; lastInsertRowid: number }>('sql_run', { sql, params: normalize(params) });
    return { changes: Number(result?.changes ?? 0), lastInsertRowid: Number(result?.lastInsertRowid ?? 0) };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.call<T[]>('sql_all', { sql, params: normalize(params) }) ?? [];
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const value = await this.call<T | null>('sql_get', { sql, params: normalize(params) });
    return value === null ? undefined : value;
  }

  async pragmaValue(name: string): Promise<unknown> {
    return this.call<unknown>('sql_pragma', { name });
  }

  async serialize(): Promise<Uint8Array> {
    const bytes = await this.call<number[]>('sql_backup_bytes');
    return Uint8Array.from(bytes ?? []);
  }

  async deserialize(bytes: Uint8Array): Promise<void> {
    await this.call('sql_restore_bytes', { bytes: Array.from(bytes) });
  }
}

function normalize(params: SqlParam[]): (string | number | null)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'bigint') return Number(p);
    if (p instanceof Uint8Array) return Array.from(p).join(','); // binary payloads are not used by the schema
    return p as string | number;
  });
}
