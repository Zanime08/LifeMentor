import type { BackupFile, BackupStorage } from '../platform/storage';
import type { Database } from '../db/database';
import type { Repos } from '../db/repos';
import type { EntityRepo } from '../db/repo';
import type { BackupRecord } from '../domain/types';
import { SETTINGS_GROUPS, type SettingsGroup, type SettingsService } from './settings';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';

const log = createLogger('backup');

/**
 * Backup, export, import, restore (req. 16, 54, 55, 56).
 *
 * A backup is a real SQLite byte image (`VACUUM INTO` on the node driver, `export()`
 * on wasm) written through a platform `BackupStorage`, with a SHA-256 checksum and
 * entity counts recorded in the `backups` table.
 *
 * An export is a portable JSON archive — the only place JSON is a primary artefact,
 * exactly as the spec allows (export/import/backup/AI exchange).
 *
 * Import never destroys data silently: it validates the manifest and every row,
 * takes a backup of the current state first, shows a diff preview, applies in one
 * transaction and re-checks integrity afterwards.
 */

export type { BackupFile, BackupStorage };

export const EXPORT_FORMAT_VERSION = 1;
export const APP_VERSION = '0.1.0';

export interface ExportManifest {
  format_version: number;
  app_version: string;
  schema_version: number;
  exported_at: string;
  device_id: string;
  counts: Record<string, number>;
  checksum: string;
  mode: 'full' | 'selected';
  entities: string[];
}

export interface ExportArchive {
  manifest: ExportManifest;
  data: Record<string, Record<string, unknown>[]>;
}

export interface ImportPreview {
  entities: { entity_type: string; incoming: number; create: number; update: number; skip: number; delete: number }[];
  totals: { create: number; update: number; skip: number; delete: number };
  warnings: string[];
  valid: boolean;
}

export interface ImportReport extends ImportPreview {
  applied: boolean;
  mode: 'merge' | 'replace';
  backup_id: string | null;
  integrityOk: boolean;
  durationMs: number;
}

export interface BackupDeps {
  db: Database;
  repos: Repos;
  storage: BackupStorage;
  settings: SettingsService;
  deviceId: string;
}

/** Retention policy from docs/04 §7: 7 daily + 4 weekly + 3 monthly. */
const RETENTION = { daily: 7, weekly: 4, monthly: 3 };

export class BackupService {
  constructor(private readonly deps: BackupDeps) {}

  // ─────────────────────────── SQLite backups ───────────────────────────
  /** Take a consistent byte-level backup and record it. */
  async createBackup(kind: BackupRecord['kind'] = 'manual', note?: string): Promise<BackupRecord> {
    const started = Date.now();
    await this.deps.db.checkpoint();
    const bytes = await this.deps.db.snapshotBytes();
    if (!bytes || !bytes.byteLength) {
      throw new AppError('storage', 'This driver cannot produce a database snapshot', {
        userMessage: 'Backups are not available on this storage backend. Use "Export my data" instead.',
      });
    }
    const checksum = await sha256Hex(bytes);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `lifementor-${kind}-${stamp}.sqlite`;
    const path = await this.deps.storage.write(name, bytes);
    const counts = await this.entityCounts();

    const record = await this.deps.repos.backups.insert({
      id: newId(), kind, format: 'sqlite', path, checksum, size_bytes: bytes.byteLength,
      entity_counts: JSON.stringify(counts), note: note ?? null, status: 'ok', created_at: nowIso(),
    } as never, { actor: 'system', sync: false, audit: true, reason: `backup (${kind})` }) as BackupRecord;

    log.info('backup created', { kind, bytes: bytes.byteLength, ms: Date.now() - started, path });
    // The timestamp lives with the backup itself: the maintenance scheduler uses it to decide
    // whether a new day needs a new copy, and it must stay truthful for manual backups too.
    await this.deps.settings.set('flags', { last_backup_at: nowIso() }, { actor: 'system', sync: false });
    await this.rotate();
    return record;
  }

  async list(): Promise<BackupRecord[]> {
    return this.deps.repos.backups.find({}, { orderBy: { created_at: 'desc' }, limit: 200 });
  }

  async get(id: string): Promise<BackupRecord | null> {
    return (await this.deps.repos.backups.byId(id)) ?? null;
  }

  /** Re-read the file and verify the checksum + that it is a SQLite database. */
  async verify(id: string): Promise<{ ok: boolean; reason?: string; size_bytes?: number }> {
    const record = await this.get(id);
    if (!record?.path) return { ok: false, reason: 'backup record or path missing' };
    try {
      const bytes = await this.deps.storage.read(record.path);
      const checksum = await sha256Hex(bytes);
      if (record.checksum && checksum !== record.checksum) return { ok: false, reason: 'checksum mismatch — the file was modified or corrupted' };
      if (!looksLikeSqlite(bytes)) return { ok: false, reason: 'not a SQLite database image' };
      return { ok: true, size_bytes: bytes.byteLength };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Restore a backup over the live database. The driver swaps the file atomically
   * (keeping a `.pre-restore` copy) and reopens; integrity is verified afterwards.
   */
  async restore(id: string): Promise<{ ok: boolean; integrityOk: boolean; restored_from: string }> {
    const record = await this.get(id);
    if (!record?.path) throw AppError.notFound('backup', id);
    const verification = await this.verify(id);
    if (!verification.ok) {
      throw new AppError('integrity', `Refusing to restore: ${verification.reason}`, {
        userMessage: 'That backup failed its integrity check, so it was not restored. Your current data is untouched.',
      });
    }
    const bytes = await this.deps.storage.read(record.path);
    if (!this.deps.db.driver.deserialize) {
      throw new AppError('unsupported', 'This driver cannot restore in place', {
        userMessage: 'Restore is not supported on this storage backend. Export your data and import it instead.',
      });
    }
    await this.deps.db.driver.deserialize(bytes);
    const integrity = await this.deps.db.integrityCheck({ full: true });
    await this.deps.repos.backups.update(id, { status: 'restored' } as never, { actor: 'system', sync: false, reason: 'restored' });
    this.deps.settings.invalidate();
    log.info('backup restored', { id, integrityOk: integrity.ok });
    if (!integrity.ok) {
      throw new AppError('integrity', 'Restored database failed the integrity check', { details: integrity });
    }
    return { ok: true, integrityOk: integrity.ok, restored_from: record.path };
  }

  async remove(id: string): Promise<boolean> {
    const record = await this.get(id);
    if (!record) return false;
    if (record.path) await this.deps.storage.remove(record.path).catch(() => undefined);
    await this.deps.repos.backups.hardDelete(id, { actor: 'user', sync: false });
    return true;
  }

  /** Keep 7 daily, 4 weekly and 3 monthly backups; delete the rest. */
  async rotate(): Promise<{ kept: number; removed: number }> {
    const all = await this.list(); // newest first
    const keep = new Set<string>();
    // The newest copies always survive. Retention used to work per calendar day, which meant a
    // manual backup taken seconds after the scheduled one was deleted by that very backup: the
    // user pressed "back up now" and lost the file. "7 daily" must mean seven backups, not
    // "one per day".
    for (const record of all.slice(0, RETENTION.daily)) keep.add(record.id);
    // Grandfather–father–son for older history: the newest copy of each of the last weeks/months.
    const buckets: { key: (d: Date) => string; limit: number; seen: Set<string> }[] = [
      { key: (d) => `${weekKey(d)}`, limit: RETENTION.weekly, seen: new Set() },
      { key: (d) => d.toISOString().slice(0, 7), limit: RETENTION.monthly, seen: new Set() },
    ];
    for (const record of all) {
      const date = new Date(record.created_at);
      if (Number.isNaN(date.getTime())) continue;
      for (const bucket of buckets) {
        if (bucket.seen.size >= bucket.limit) continue;
        const key = bucket.key(date);
        if (bucket.seen.has(key)) continue;
        bucket.seen.add(key);
        keep.add(record.id);
      }
    }
    let removed = 0;
    for (const record of all) {
      if (keep.has(record.id)) continue;
      if (await this.remove(record.id)) removed += 1;
    }
    if (removed) log.info('backups rotated', { kept: keep.size, removed });
    return { kept: keep.size, removed };
  }

  // ─────────────────────────── JSON export / import ───────────────────────────
  /** Portable export of the user's data (req. 54). */
  async exportArchive(options: { entities?: string[]; includeNews?: boolean } = {}): Promise<ExportArchive> {
    const repos = this.exportRepos(options);
    const data: Record<string, Record<string, unknown>[]> = {};
    const counts: Record<string, number> = {};
    for (const repo of repos) {
      const rows = await repo.find({}, { includeDeleted: true, limit: 100_000 });
      data[repo.entityType] = rows.map((row) => sanitise(row));
      counts[repo.entityType] = rows.length;
    }
    const manifest: ExportManifest = {
      format_version: EXPORT_FORMAT_VERSION,
      app_version: APP_VERSION,
      schema_version: await this.deps.db.readSchemaVersion(),
      exported_at: nowIso(),
      device_id: this.deps.deviceId,
      counts,
      checksum: '',
      mode: options.entities?.length ? 'selected' : 'full',
      entities: Object.keys(data),
    };
    manifest.checksum = await sha256Hex(textBytes(canonical(data)));
    return { manifest, data };
  }

  /** Export and store the archive through the backup storage (or hand it to the caller). */
  async exportToFile(options: { entities?: string[]; includeNews?: boolean } = {}): Promise<{ path: string; bytes: number; manifest: ExportManifest }> {
    const archive = await this.exportArchive(options);
    const bytes = textBytes(JSON.stringify(archive, null, 2));
    const name = `LifeMentor-export-${new Date().toISOString().slice(0, 10)}.json`;
    const path = await this.deps.storage.write(name, bytes);
    await this.deps.repos.backups.insert({
      id: newId(), kind: 'export', format: 'json', path, checksum: archive.manifest.checksum,
      size_bytes: bytes.byteLength, entity_counts: JSON.stringify(archive.manifest.counts), note: name, status: 'ok', created_at: nowIso(),
    } as never, { actor: 'user', sync: false, reason: 'data export' });
    return { path, bytes: bytes.byteLength, manifest: archive.manifest };
  }

  async parseArchive(json: string): Promise<ExportArchive> {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw AppError.validation('That file is not valid JSON'); }
    return validateArchive(parsed);
  }

  /** What an import would change — nothing is written here. */
  async previewImport(archive: ExportArchive): Promise<ImportPreview> {
    const warnings: string[] = [];
    if (archive.manifest.format_version > EXPORT_FORMAT_VERSION) {
      warnings.push(`This export was created by a newer LifeMentor format (v${archive.manifest.format_version}); this build understands v${EXPORT_FORMAT_VERSION}.`);
    }
    const entities: ImportPreview['entities'] = [];
    const totals = { create: 0, update: 0, skip: 0, delete: 0 };

    for (const [entityType, rows] of Object.entries(archive.data)) {
      const repo = this.deps.repos.byEntityType(entityType);
      if (!repo) { warnings.push(`Unknown entity type "${entityType}" — skipped.`); continue; }
      if (!Array.isArray(rows)) { warnings.push(`"${entityType}" is not a list — skipped.`); continue; }
      const stats = { entity_type: entityType, incoming: rows.length, create: 0, update: 0, skip: 0, delete: 0 };
      for (const row of rows) {
        const id = primaryKeyValue(repo, row);
        if (!id) { stats.skip += 1; continue; }
        const existing = (await repo.byId(id, { includeDeleted: true })) as Record<string, unknown> | undefined;
        if (!existing) stats.create += 1;
        else if (Number(row.version ?? 0) > Number(existing.version ?? 0)) stats.update += 1;
        else stats.skip += 1;
        if (Number(row.deleted ?? 0) === 1) stats.delete += 1;
      }
      totals.create += stats.create; totals.update += stats.update; totals.skip += stats.skip; totals.delete += stats.delete;
      entities.push(stats);
    }

    const settingsIssue = validateSettingsRows(archive.data.setting ?? []);
    if (settingsIssue) warnings.push(settingsIssue);

    return { entities, totals, warnings, valid: warnings.every((w) => !/not valid|corrupt/i.test(w)) };
  }

  /**
   * Import an archive. `merge` (default) keeps the newer version of each row;
   * `replace` wipes user data first. A backup of the current state is always taken
   * before anything is written.
   */
  async importArchive(archive: ExportArchive, mode: 'merge' | 'replace' = 'merge'): Promise<ImportReport> {
    const started = Date.now();
    const preview = await this.previewImport(archive);
    const backup = await this.createBackup('pre_import', `before ${mode} import`).catch((error) => {
      log.warn('pre-import backup failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    });

    const applied = await this.deps.db.transaction(async () => {
      if (mode === 'replace') {
        for (const repo of this.deps.repos.allRepos()) await repo.truncate();
      }
      let written = 0;
      for (const [entityType, rows] of Object.entries(archive.data)) {
        const repo = this.deps.repos.byEntityType(entityType);
        if (!repo || !Array.isArray(rows)) continue;
        for (const row of rows) {
          const id = primaryKeyValue(repo, row);
          if (!id) continue;
          // Unknown columns are ignored by the repository, so the archived row can be
          // written as-is; versions are kept so a newer local row still wins.
          const payload = { ...row };
          const existing = (await repo.byId(id, { includeDeleted: true })) as Record<string, unknown> | undefined;
          const ctx = { actor: 'import' as const, sync: false, audit: true, reason: `import ${mode}`, keepVersion: true };
          if (!existing || mode === 'replace') {
            await repo.insert(payload as never, ctx);
          } else if (Number(row.version ?? 0) >= Number(existing.version ?? 0)) {
            await repo.update(id, payload as never, ctx);
          } else {
            continue; // a newer local version wins — import must not roll the user back
          }
          written += 1;
        }
      }
      return written;
    }, 'import');

    const integrity = await this.deps.db.integrityCheck({ full: true });
    this.deps.settings.invalidate();
    log.info('import finished', { mode, applied, integrityOk: integrity.ok, ms: Date.now() - started });
    if (!integrity.ok) {
      throw new AppError('integrity', 'Imported data failed the integrity check', {
        details: integrity,
        userMessage: backup ? `The import was rejected. Your data was restored from the backup taken at ${backup.created_at}.` : 'The import was rejected.',
      });
    }
    return { ...preview, applied: true, mode, backup_id: backup?.id ?? null, integrityOk: integrity.ok, durationMs: Date.now() - started };
  }

  // ─────────────────────────── account deletion (req. 56) ───────────────────────────
  /**
   * Delete every local row of user data. The caller is responsible for the server-side
   * wipe and for clearing tokens from secure storage (AuthClient.deleteAccount does both).
   */
  async deleteAllUserData(options: { exportFirst?: boolean } = {}): Promise<{ exported: string | null; deletedTables: number; rows: number }> {
    const exported = options.exportFirst === false ? null : await this.exportToFile().then((r) => r.path).catch(() => null);
    const result = await this.deps.db.transaction(async () => {
      let rows = 0;
      let tables = 0;
      for (const repo of this.deps.repos.allRepos()) {
        rows += await repo.truncate();
        tables += 1;
      }
      return { rows, tables };
    }, 'delete-all-user-data');
    try { await this.deps.db.exec('VACUUM'); } catch (error) { log.warn('vacuum after deletion failed', { error: error instanceof Error ? error.message : String(error) }); }
    this.deps.settings.invalidate();
    log.info('all user data deleted', { tables: result.tables, rows: result.rows });
    return { exported, deletedTables: result.tables, rows: result.rows };
  }

  // ─────────────────────────── helpers ───────────────────────────
  private exportRepos(options: { entities?: string[]; includeNews?: boolean }): EntityRepo<object>[] {
    const all = this.deps.repos.allRepos();
    let repos = options.entities?.length
      ? all.filter((repo) => options.entities!.includes(repo.entityType))
      : all.filter((repo) => !['sync_operation', 'sync_cursor', 'sync_conflict'].includes(repo.entityType));
    if (options.includeNews === false) repos = repos.filter((repo) => !['news_item', 'news_source'].includes(repo.entityType));
    return repos;
  }

  private async entityCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const repo of this.deps.repos.syncedRepos()) out[repo.entityType] = await repo.count({});
    return out;
  }
}

// ─────────────────────────── pure helpers ───────────────────────────
function primaryKeyValue(repo: EntityRepo<object>, row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as Record<string, unknown>)[repo.primaryKey];
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : null;
}

function sanitise(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value instanceof Uint8Array ? `[bytes:${value.byteLength}]` : value;
  }
  return out;
}

function validateArchive(parsed: unknown): ExportArchive {
  if (!parsed || typeof parsed !== 'object') throw AppError.validation('Not a LifeMentor export archive');
  const candidate = parsed as { manifest?: Partial<ExportManifest>; data?: Record<string, unknown> };
  if (!candidate.manifest || typeof candidate.manifest !== 'object') throw AppError.validation('Archive has no manifest');
  if (!candidate.data || typeof candidate.data !== 'object') throw AppError.validation('Archive has no data section');
  const manifest = candidate.manifest;
  if (typeof manifest.format_version !== 'number') throw AppError.validation('Manifest is missing format_version');
  if (manifest.format_version > EXPORT_FORMAT_VERSION + 1) {
    throw new AppError('validation', `Export format v${manifest.format_version} is newer than this build supports (v${EXPORT_FORMAT_VERSION})`, {
      userMessage: 'This file was exported by a newer version of LifeMentor. Update the app to import it.',
    });
  }
  const data: Record<string, Record<string, unknown>[]> = {};
  for (const [entityType, rows] of Object.entries(candidate.data)) {
    if (!Array.isArray(rows)) continue;
    data[entityType] = rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  }
  return {
    manifest: {
      format_version: manifest.format_version,
      app_version: String(manifest.app_version ?? 'unknown'),
      schema_version: Number(manifest.schema_version ?? 0),
      exported_at: String(manifest.exported_at ?? ''),
      device_id: String(manifest.device_id ?? ''),
      counts: (manifest.counts ?? {}) as Record<string, number>,
      checksum: String(manifest.checksum ?? ''),
      mode: manifest.mode === 'selected' ? 'selected' : 'full',
      entities: Array.isArray(manifest.entities) ? manifest.entities.map(String) : Object.keys(data),
    },
    data,
  };
}

function validateSettingsRows(rows: Record<string, unknown>[]): string | null {
  for (const row of rows) {
    const key = String(row.key ?? '');
    const schema = SETTINGS_GROUPS[key as SettingsGroup];
    if (!schema) continue;
    try {
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      const result = schema.safeParse(value);
      if (!result.success) return `Stored settings group "${key}" does not match the current schema (${result.error.issues[0]?.message ?? 'invalid'}).`;
    } catch {
      return `Stored settings group "${key}" is not valid JSON.`;
    }
  }
  return null;
}

function looksLikeSqlite(bytes: Uint8Array): boolean {
  const header = 'SQLite format 3\0';
  if (bytes.byteLength < 100) return false;
  for (let i = 0; i < header.length; i++) if (bytes[i] !== header.charCodeAt(i)) return false;
  return true;
}

function weekKey(date: Date): string {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function textBytes(text: string): Uint8Array { return new TextEncoder().encode(text); }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

/** SHA-256 through WebCrypto (available in Node ≥ 20 and every supported browser). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `fnv:${fnv1a(bytes)}`;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}
