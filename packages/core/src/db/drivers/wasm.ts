import type { DriverOptions, RunResult, SqlDriver, SqlParam } from '../driver';

/**
 * Where a WASM SQLite image is durably stored between sessions.
 * Browser: IndexedDB. Tests: memory. Desktop/mobile shells never use this driver.
 */
export interface PersistenceBackend {
  readonly describe: string;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}

export class MemoryPersistence implements PersistenceBackend {
  readonly describe = 'memory';
  private bytes: Uint8Array | null = null;
  async load(): Promise<Uint8Array | null> { return this.bytes; }
  async save(bytes: Uint8Array): Promise<void> { this.bytes = bytes; }
  async remove(): Promise<void> { this.bytes = null; }
}

export class IndexedDbPersistence implements PersistenceBackend {
  readonly describe: string;
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = 'lifementor', private readonly storeName = 'sqlite', private readonly key = 'main') {
    this.describe = `indexeddb:${dbName}/${storeName}/${key}`;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return this.dbp;
  }

  private tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.openDb().then((db) => new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode);
      const req = fn(transaction.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    }));
  }

  async load(): Promise<Uint8Array | null> {
    try {
      const value = await this.tx<Uint8Array | undefined>('readonly', (s) => s.get(this.key) as IDBRequest<Uint8Array | undefined>);
      return value ? new Uint8Array(value) : null;
    } catch { return null; }
  }

  async save(bytes: Uint8Array): Promise<void> {
    await this.tx('readwrite', (s) => s.put(bytes, this.key) as IDBRequest<unknown>);
  }

  async remove(): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(this.key) as IDBRequest<unknown>);
  }
}

type SqlJsStatic = import('sql.js').SqlJsStatic;
type SqlJsDatabase = import('sql.js').Database;

/**
 * WASM driver (sql.js). This is a **real SQLite engine** compiled to WebAssembly; it exists so the
 * browser dev preview and the automated web tests exercise the same SQL as production.
 *
 * Durability: after every committed transaction the whole image is written to the persistence
 * backend (IndexedDB in the browser). Production shells use the native drivers with WAL instead.
 */
export class WasmSqlDriver implements SqlDriver {
  readonly kind = 'wasm' as const;
  private db: SqlJsDatabase | null = null;
  private sql: SqlJsStatic | null = null;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;

  constructor(
    private readonly options: DriverOptions & { persistence?: PersistenceBackend; wasmUrl?: string | (() => string) } = {},
  ) {}

  get isOpen(): boolean { return this.db !== null; }
  get persistence(): PersistenceBackend | undefined { return this.options.persistence; }

  describe(): string {
    return `wasm:${this.options.persistence?.describe ?? 'ephemeral'}`;
  }

  async open(): Promise<void> {
    if (this.db) return;
    const initSqlJs = (await import('sql.js')).default;
    const locateFile = typeof this.options.wasmUrl === 'function'
      ? this.options.wasmUrl
      : this.options.wasmUrl ? () => this.options.wasmUrl as string : undefined;
    this.sql = await initSqlJs(locateFile ? { locateFile: () => locateFile() } : undefined);
    const saved = this.options.persistence ? await this.options.persistence.load() : null;
    this.db = saved && saved.byteLength > 0 ? new this.sql.Database(saved) : new this.sql.Database();
    this.applyPragmas();
  }

  /**
   * sql.js resets connection pragmas (notably `foreign_keys`) when the image is exported,
   * so they are re-asserted after every serialize/flush. Verified by the driver test suite.
   */
  private applyPragmas(): void {
    if (!this.db) return;
    for (const pragma of ['PRAGMA foreign_keys = ON', `PRAGMA busy_timeout = ${this.options.busyTimeoutMs ?? 5000}`, 'PRAGMA temp_store = MEMORY']) {
      try { this.db.exec(pragma); } catch { /* ignore */ }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.db?.close();
    this.db = null;
  }

  private handle(): SqlJsDatabase {
    if (!this.db) throw new Error('WasmSqlDriver: database is not open');
    return this.db;
  }

  async exec(sql: string): Promise<void> {
    this.handle().run(sql);
    this.dirty = true;
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const db = this.handle();
    db.run(sql, normalize(params));
    this.dirty = true;
    const changes = Number(db.getRowsModified?.() ?? 0);
    return { changes, lastInsertRowid: 0 };
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const db = this.handle();
    const stmt = db.prepare(sql);
    try {
      if (params.length) stmt.bind(normalize(params));
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally { stmt.free(); }
  }

  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async pragmaValue(name: string): Promise<unknown> {
    const row = await this.get<Record<string, unknown>>(`PRAGMA ${name}`);
    return row ? Object.values(row)[0] : undefined;
  }

  async serialize(): Promise<Uint8Array> {
    const bytes = this.handle().export();
    this.applyPragmas(); // export() resets connection pragmas in sql.js
    return bytes;
  }

  async deserialize(bytes: Uint8Array): Promise<void> {
    if (!this.sql) throw new Error('WasmSqlDriver: not open');
    this.db?.close();
    this.db = new this.sql.Database(bytes);
    this.applyPragmas();
    this.dirty = true;
    await this.flush();
  }

  /** Persist the image now (called by Database.transaction after COMMIT). */
  async flush(): Promise<void> {
    if (!this.db || !this.options.persistence || !this.dirty) return;
    if (this.flushPromise) await this.flushPromise;
    const bytes = this.db.export();
    this.applyPragmas(); // export() resets connection pragmas in sql.js
    this.dirty = false;
    this.flushPromise = this.options.persistence.save(bytes).finally(() => { this.flushPromise = null; });
    await this.flushPromise;
  }
}

function normalize(params: SqlParam[]): (number | string | Uint8Array | null)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'bigint') return Number(p);
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'number' || typeof p === 'string') return p;
    return String(p);
  });
}
