import type { Database } from './database';
import type { SqlParam } from './driver';
import type { Actor, SyncState } from '../domain/types';
import { newId } from '../util/id';
import { nowIso } from '../util/time';

/** Who/why is performing a write — recorded in change_log and sync_queue. */
export interface WriteContext {
  actor: Actor;
  reason?: string;
  correlationId?: string;
  deviceId?: string;
  /** Enqueue a sync operation (default true for synced entities). */
  sync?: boolean;
  /** Write a change_log row (default true). */
  audit?: boolean;
  /** Skip version bump — only for sync/import applying a remote state. */
  keepVersion?: boolean;
}

export const USER_WRITE: WriteContext = { actor: 'user' };
export const AI_WRITE: WriteContext = { actor: 'ai' };
export const SYSTEM_WRITE: WriteContext = { actor: 'system' };
export const SYNC_WRITE: WriteContext = { actor: 'sync', sync: true, audit: true };

export type WhereValue =
  | string | number | boolean | null
  | { op: 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'neq' | 'is_null' | 'not_null' | 'between'; value?: unknown };

export type Where = Record<string, WhereValue>;

export interface QueryOptions {
  orderBy?: string | Record<string, 'asc' | 'desc'>;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export interface EntitySpec {
  table: string;
  entityType: string;
  /** participates in cloud sync (sync_queue) */
  synced: boolean;
  /** primary key column */
  pk?: string;
  /** columns managed automatically */
  versioned?: boolean;
  /** priority for sync ordering (higher goes first) */
  syncPriority?: number;
}

const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/i;

function assertColumn(name: string): string {
  if (!SAFE_COLUMN.test(name)) throw new Error(`Unsafe column name: ${name}`);
  return name;
}

function encode(value: unknown): SqlParam {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SqlParam;
}

export function buildWhere(where: Where | undefined, opts: QueryOptions, hasDeletedColumn: boolean): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (hasDeletedColumn && !opts.includeDeleted) {
    clauses.push('deleted = 0');
  }
  for (const [column, raw] of Object.entries(where ?? {})) {
    const col = assertColumn(column);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'op' in (raw as Record<string, unknown>)) {
      const { op, value } = raw as { op: string; value?: unknown };
      switch (op) {
        case 'in': case 'not_in': {
          const list = Array.isArray(value) ? value : [];
          if (list.length === 0) { clauses.push(op === 'in' ? '1 = 0' : '1 = 1'); break; }
          clauses.push(`${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${list.map(() => '?').join(',')})`);
          params.push(...list.map(encode));
          break;
        }
        case 'gt': clauses.push(`${col} > ?`); params.push(encode(value)); break;
        case 'gte': clauses.push(`${col} >= ?`); params.push(encode(value)); break;
        case 'lt': clauses.push(`${col} < ?`); params.push(encode(value)); break;
        case 'lte': clauses.push(`${col} <= ?`); params.push(encode(value)); break;
        case 'like': clauses.push(`${col} LIKE ?`); params.push(encode(value)); break;
        case 'neq': clauses.push(`${col} IS NOT ?`); params.push(encode(value)); break;
        case 'between': {
          const [lo, hi] = Array.isArray(value) ? value : [undefined, undefined];
          if (lo === undefined || hi === undefined) { clauses.push('1 = 1'); break; }
          clauses.push(`${col} BETWEEN ? AND ?`);
          params.push(encode(lo), encode(hi));
          break;
        }
        case 'is_null': clauses.push(`${col} IS NULL`); break;
        case 'not_null': clauses.push(`${col} IS NOT NULL`); break;
        default: throw new Error(`Unsupported where operator: ${op}`);
      }
    } else if (raw === null) {
      clauses.push(`${col} IS NULL`);
    } else {
      clauses.push(`${col} = ?`);
      params.push(encode(raw));
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function buildOrderBy(orderBy: QueryOptions['orderBy']): string {
  if (!orderBy) return '';
  if (typeof orderBy === 'string') return `ORDER BY ${assertColumn(orderBy)}`;
  const parts = Object.entries(orderBy).map(([col, dir]) => `${assertColumn(col)} ${dir === 'desc' ? 'DESC' : 'ASC'}`);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

/**
 * Generic repository: one code path for create/update/delete on every entity, which is what
 * guarantees the three invariants of the persistence layer (req. 8, 9, 12, 61):
 *   1. every write bumps `version` + `updated_at`,
 *   2. every write records `change_log` (before/after/actor/reason),
 *   3. every write to a synced entity enqueues a `sync_queue` operation —
 * all inside the caller's transaction.
 */
export class EntityRepo<Row extends object> {
  readonly table: string;
  readonly entityType: string;
  private readonly pk: string;
  private columns: string[] | null = null;

  constructor(private readonly db: Database, private readonly spec: EntitySpec) {
    this.table = spec.table;
    this.entityType = spec.entityType;
    this.pk = spec.pk ?? 'id';
  }

  private get versioned(): boolean { return this.spec.versioned !== false; }

  /** Primary key column — needed by import/merge and diagnostics. */
  get primaryKey(): string { return this.pk; }

  get isSynced(): boolean { return this.spec.synced; }

  get syncPriority(): number { return this.spec.syncPriority ?? 0; }

  private async columnNames(): Promise<string[]> {
    if (this.columns) return this.columns;
    const rows = await this.db.all<{ name: string }>(`PRAGMA table_info(${this.table})`);
    this.columns = rows.map((r) => r.name);
    return this.columns;
  }

  private hasDeleted(cols: string[]): boolean { return cols.includes('deleted'); }

  /** Insert a row, filling bookkeeping columns. Returns the stored row. */
  async insert(row: Partial<Row>, ctx: WriteContext = USER_WRITE): Promise<Row> {
    const cols = await this.columnNames();
    const at = nowIso();
    const record: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    if (cols.includes(this.pk) && record[this.pk] == null) record[this.pk] = newId();
    if (cols.includes('created_at') && record.created_at == null) record.created_at = at;
    if (cols.includes('updated_at') && record.updated_at == null) record.updated_at = at;
    if (this.versioned && cols.includes('version') && record.version == null) record.version = 1;
    if (cols.includes('deleted') && record.deleted == null) record.deleted = 0;
    if (cols.includes('sync_state')) {
      const isSynced = this.spec.synced && ctx.sync !== false;
      record.sync_state = (record.sync_state as SyncState) ?? (isSynced ? 'pending' : 'local');
    }

    const keys = Object.keys(record).filter((k) => cols.includes(k));
    const sql = `INSERT INTO ${this.table} (${keys.map(assertColumn).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    await this.db.run(sql, keys.map((k) => encode(record[k])));
    const stored = await this.byIdRaw(String(record[this.pk]));
    if (!stored) throw new Error(`Insert into ${this.table} did not return a row`);
    const storedRecord = stored as Record<string, unknown>;

    if (ctx.audit !== false) {
      await this.writeChangeLog('create', null, stored, ctx);
    }
    if (this.spec.synced && ctx.sync !== false) {
      await this.enqueue('create', stored, 0, Number(storedRecord.version ?? 1), ctx);
    }
    return stored;
  }

  /** Update by primary key. `patch` may omit bookkeeping columns. */
  async update(id: string, patch: Partial<Row>, ctx: WriteContext = USER_WRITE): Promise<Row | undefined> {
    const cols = await this.columnNames();
    const before = await this.byIdRaw(id, { includeDeleted: true });
    if (!before) return undefined;
    const beforeRecord = before as Record<string, unknown>;

    const record: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
    delete record[this.pk];
    if (cols.includes('updated_at')) {
      // Applying an authoritative external state (a pulled remote row, an imported archive) must keep
      // the timestamp it carries — conflict resolution and merge compare `updated_at` across devices.
      const authoritative = ctx.keepVersion === true || ctx.actor === 'sync' || ctx.actor === 'import';
      record.updated_at = authoritative && typeof record.updated_at === 'string' ? record.updated_at : nowIso();
    }
    if (this.versioned && cols.includes('version') && !ctx.keepVersion) {
      record.version = Number(beforeRecord.version ?? 0) + 1;
    }
    if (cols.includes('sync_state') && ctx.actor !== 'sync') {
      record.sync_state = this.spec.synced && ctx.sync !== false ? 'pending' : (record.sync_state as SyncState) ?? (beforeRecord.sync_state as SyncState) ?? 'local';
    }

    const keys = Object.keys(record).filter((k) => cols.includes(k));
    if (keys.length > 0) {
      const sql = `UPDATE ${this.table} SET ${keys.map((k) => `${assertColumn(k)} = ?`).join(', ')} WHERE ${assertColumn(this.pk)} = ?`;
      await this.db.run(sql, [...keys.map((k) => encode(record[k])), id]);
    }
    const after = await this.byIdRaw(id, { includeDeleted: true });
    if (!after) return undefined;

    if (ctx.audit !== false) await this.writeChangeLog('update', before, after, ctx);
    if (this.spec.synced && ctx.sync !== false) {
      await this.enqueue('update', after, Number(beforeRecord.version ?? 0), Number((after as Record<string, unknown>).version ?? 1), ctx);
    }
    return after;
  }

  /** Soft delete: keeps history + syncs the deletion to other devices. */
  async softDelete(id: string, ctx: WriteContext = USER_WRITE): Promise<Row | undefined> {
    const cols = await this.columnNames();
    if (!this.hasDeleted(cols)) return this.hardDelete(id, ctx);
    return this.update(id, { deleted: 1 } as unknown as Partial<Row>, ctx);
  }

  async restore(id: string, ctx: WriteContext = USER_WRITE): Promise<Row | undefined> {
    return this.update(id, { deleted: 0 } as unknown as Partial<Row>, ctx);
  }

  async hardDelete(id: string, ctx: WriteContext = USER_WRITE): Promise<Row | undefined> {
    const before = await this.byIdRaw(id, { includeDeleted: true });
    if (!before) return undefined;
    await this.db.run(`DELETE FROM ${this.table} WHERE ${assertColumn(this.pk)} = ?`, [id]);
    const beforeRecord = before as Record<string, unknown>;
    if (ctx.audit !== false) await this.writeChangeLog('delete', before, null, ctx);
    if (this.spec.synced && ctx.sync !== false) await this.enqueue('delete', before, Number(beforeRecord.version ?? 0), Number(beforeRecord.version ?? 1), ctx);
    return before;
  }

  async byId(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Row | undefined> {
    return this.byIdRaw(id, opts);
  }

  private async byIdRaw(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Row | undefined> {
    const cols = await this.columnNames();
    const deletedClause = this.hasDeleted(cols) && !opts.includeDeleted ? ' AND deleted = 0' : '';
    return this.db.get<Row>(`SELECT * FROM ${this.table} WHERE ${assertColumn(this.pk)} = ?${deletedClause}`, [id]);
  }

  async find(where: Where = {}, opts: QueryOptions = {}): Promise<Row[]> {
    const cols = await this.columnNames();
    const { sql, params } = buildWhere(where, opts, this.hasDeleted(cols));
    const order = buildOrderBy(opts.orderBy);
    const limit = opts.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : '';
    const offset = opts.offset ? `OFFSET ${Math.max(0, Math.floor(opts.offset))}` : '';
    return this.db.all<Row>(`SELECT * FROM ${this.table} ${sql} ${order} ${limit} ${offset}`.replace(/\s+/g, ' '), params);
  }

  async findOne(where: Where = {}, opts: QueryOptions = {}): Promise<Row | undefined> {
    const rows = await this.find(where, { ...opts, limit: 1 });
    return rows[0];
  }

  async count(where: Where = {}, opts: QueryOptions = {}): Promise<number> {
    const cols = await this.columnNames();
    const { sql, params } = buildWhere(where, opts, this.hasDeleted(cols));
    return Number(await this.db.scalar<number>(`SELECT COUNT(*) FROM ${this.table} ${sql}`, params) ?? 0);
  }

  async exists(where: Where = {}): Promise<boolean> {
    return (await this.count(where)) > 0;
  }

  /** Purge every row — used only by account deletion / import replace mode. */
  async truncate(): Promise<number> {
    const res = await this.db.run(`DELETE FROM ${this.table}`);
    return res.changes;
  }

  // ─────────────────────── audit + sync bookkeeping ───────────────────────
  private async writeChangeLog(action: string, before: Row | null, after: Row | null, ctx: WriteContext): Promise<void> {
    const beforeRecord = before as Record<string, unknown> | null;
    const afterRecord = after as Record<string, unknown> | null;
    await this.db.run(
      `INSERT INTO change_log (id, entity_type, entity_id, action, before_json, after_json, actor, reason, correlation_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        this.entityType,
        String((afterRecord ?? beforeRecord)?.[this.pk] ?? ''),
        action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        ctx.actor,
        ctx.reason ?? null,
        ctx.correlationId ?? null,
        nowIso(),
      ],
    );
  }

  private async enqueue(operationType: 'create' | 'update' | 'delete', row: Row, baseVersion: number, version: number, ctx: WriteContext): Promise<void> {
    const record = row as Record<string, unknown>;
    const id = String(record[this.pk]);
    const payload = JSON.stringify(record);
    await this.db.run(
      `INSERT INTO sync_queue (operation_id, entity_type, entity_id, operation_type, payload, base_version, version,
                               priority, device_id, attempts, last_error, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'pending', ?, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      [
        newId('op'), this.entityType, id, operationType, payload, baseVersion, version,
        this.spec.syncPriority ?? 0, ctx.deviceId ?? null, nowIso(), nowIso(),
      ],
    );
  }
}

/** Repositories that are pure local/derived data (no sync, no version column). */
export function localSpec(table: string, entityType: string, extra: Partial<EntitySpec> = {}): EntitySpec {
  return { table, entityType, synced: false, versioned: false, ...extra };
}

export function syncedSpec(table: string, entityType: string, syncPriority = 0): EntitySpec {
  return { table, entityType, synced: true, versioned: true, syncPriority };
}
