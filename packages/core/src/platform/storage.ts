/**
 * Backup storage — where durable backup files live on each platform.
 *
 * The core stays platform-independent: it only knows this interface. The Node
 * implementation (server, CLI, tests, Windows shell fallback) writes real files;
 * the web implementation uses the Origin Private File System when available and
 * falls back to IndexedDB, so a browser session can still take a real backup.
 */

export interface BackupFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export interface BackupStorage {
  readonly kind: 'fs' | 'opfs' | 'indexeddb' | 'memory';
  write(name: string, bytes: Uint8Array): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  list(): Promise<BackupFile[]>;
  remove(path: string): Promise<void>;
  /** Absolute location shown in the diagnostics screen. */
  describe(): string;
}

// ─────────────────────────── Node / desktop ───────────────────────────
type FsLike = {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtime: Date }>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
};
type PathLike = { join(...parts: string[]): string };

async function nodeFs(): Promise<{ fs: FsLike; path: PathLike }> {
  const fsSpecifier = 'node:fs/promises';
  const pathSpecifier = 'node:path';
  const fs = await import(/* @vite-ignore */ fsSpecifier) as unknown as FsLike;
  const path = await import(/* @vite-ignore */ pathSpecifier) as unknown as PathLike;
  return { fs, path };
}

export interface NodeBackupStorageOptions {
  /** Directory that holds backups. Created when missing. */
  directory: string;
}

export class NodeBackupStorage implements BackupStorage {
  readonly kind = 'fs' as const;

  constructor(private readonly options: NodeBackupStorageOptions) {}

  describe(): string { return `fs:${this.options.directory}`; }

  async write(name: string, bytes: Uint8Array): Promise<string> {
    const { fs, path } = await nodeFs();
    await fs.mkdir(this.options.directory, { recursive: true });
    const target = path.join(this.options.directory, safeName(name));
    await fs.writeFile(target, bytes);
    return target;
  }

  async read(filePath: string): Promise<Uint8Array> {
    const { fs, path } = await nodeFs();
    const resolved = path.join(this.options.directory, safeName(filePath));
    return fs.readFile(resolved);
  }

  async list(): Promise<BackupFile[]> {
    const { fs, path } = await nodeFs();
    await fs.mkdir(this.options.directory, { recursive: true });
    const names = await fs.readdir(this.options.directory);
    const out: BackupFile[] = [];
    for (const name of names) {
      if (!/\.(sqlite|json|zip)$/i.test(name)) continue;
      const stat = await fs.stat(path.join(this.options.directory, name));
      out.push({ name, path: name, size: stat.size, modified: stat.mtime.toISOString() });
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async remove(filePath: string): Promise<void> {
    const { fs, path } = await nodeFs();
    await fs.rm(path.join(this.options.directory, safeName(filePath)), { force: true });
  }
}

// ─────────────────────────── Browser ───────────────────────────
/**
 * OPFS when the browser has it (Chrome/Edge/Safari), IndexedDB otherwise.
 * Both keep real bytes on the device — a browser backup is not a mock.
 */
export class WebBackupStorage implements BackupStorage {
  readonly kind: 'opfs' | 'indexeddb';
  private root: unknown | null = null;

  constructor(private readonly dbName = 'lifementor-backups', private readonly storeName = 'files') {
    this.kind = typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in (navigator.storage as unknown as Record<string, unknown>)
      ? 'opfs' : 'indexeddb';
  }

  describe(): string { return this.kind === 'opfs' ? 'opfs:/lifementor' : `indexeddb:${this.dbName}`; }

  private async opfsRoot(): Promise<any | null> {
    if (this.kind !== 'opfs') return null;
    if (this.root) return this.root;
    this.root = await (navigator as any).storage.getDirectory();
    return this.root;
  }

  async write(name: string, bytes: Uint8Array): Promise<string> {
    const safe = safeName(name);
    const root = await this.opfsRoot();
    if (root) {
      const handle = await root.getFileHandle(safe, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as BlobPart);
      await writable.close();
      return safe;
    }
    await idbPut(this.dbName, this.storeName, safe, bytes);
    return safe;
  }

  async read(path: string): Promise<Uint8Array> {
    const safe = safeName(path);
    const root = await this.opfsRoot();
    if (root) {
      const handle = await root.getFileHandle(safe);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    }
    const found = await idbGet(this.dbName, this.storeName, safe);
    if (!found) throw new Error(`Backup not found: ${safe}`);
    return found;
  }

  async list(): Promise<BackupFile[]> {
    const root = await this.opfsRoot();
    if (root) {
      const out: BackupFile[] = [];
      for await (const [name, handle] of (root as any).entries()) {
        if (handle.kind !== 'file' || !/\.(sqlite|json|zip)$/i.test(name)) continue;
        const file = await handle.getFile();
        out.push({ name, path: name, size: file.size, modified: new Date(file.lastModified).toISOString() });
      }
      return out.sort((a, b) => b.modified.localeCompare(a.modified));
    }
    return idbList(this.dbName, this.storeName);
  }

  async remove(path: string): Promise<void> {
    const safe = safeName(path);
    const root = await this.opfsRoot();
    if (root) { await (root as any).removeEntry(safe).catch(() => undefined); return; }
    await idbDelete(this.dbName, this.storeName, safe);
  }
}

// ─────────────────────────── tests / ephemeral ───────────────────────────
export class MemoryBackupStorage implements BackupStorage {
  readonly kind = 'memory' as const;
  private readonly files = new Map<string, { bytes: Uint8Array; modified: string }>();

  describe(): string { return `memory:${this.files.size} files`; }

  async write(name: string, bytes: Uint8Array): Promise<string> {
    const safe = safeName(name);
    this.files.set(safe, { bytes: new Uint8Array(bytes), modified: new Date().toISOString() });
    return safe;
  }

  async read(path: string): Promise<Uint8Array> {
    const found = this.files.get(safeName(path));
    if (!found) throw new Error(`Backup not found: ${path}`);
    return new Uint8Array(found.bytes);
  }

  async list(): Promise<BackupFile[]> {
    return [...this.files.entries()]
      .map(([name, file]) => ({ name, path: name, size: file.bytes.byteLength, modified: file.modified }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async remove(path: string): Promise<void> { this.files.delete(safeName(path)); }
}

// ─────────────────────────── helpers ───────────────────────────
export function safeName(name: string): string {
  const trimmed = name.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_');
  return trimmed || 'backup';
}

function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbPut(dbName: string, storeName: string, key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb(dbName, storeName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put({ bytes, modified: new Date().toISOString(), size: bytes.byteLength }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
  });
  db.close();
}

async function idbGet(dbName: string, storeName: string, key: string): Promise<Uint8Array | null> {
  const db = await openDb(dbName, storeName);
  const value = await new Promise<{ bytes?: Uint8Array } | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as { bytes?: Uint8Array } | undefined);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
  db.close();
  return value?.bytes ?? null;
}

async function idbList(dbName: string, storeName: string): Promise<BackupFile[]> {
  const db = await openDb(dbName, storeName);
  const entries = await new Promise<[IDBValidKey, { size?: number; modified?: string }][]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const keys = store.getAllKeys();
    const values = store.getAll();
    keys.onsuccess = () => {
      values.onsuccess = () => resolve((keys.result as IDBValidKey[]).map((k, i) => [k, (values.result as { size?: number; modified?: string }[])[i]]));
      values.onerror = () => reject(values.error ?? new Error('IndexedDB list failed'));
    };
    keys.onerror = () => reject(keys.error ?? new Error('IndexedDB list failed'));
  });
  db.close();
  return entries
    .map(([key, value]) => ({ name: String(key), path: String(key), size: value?.size ?? 0, modified: value?.modified ?? new Date(0).toISOString() }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

async function idbDelete(dbName: string, storeName: string, key: string): Promise<void> {
  const db = await openDb(dbName, storeName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
  });
  db.close();
}
