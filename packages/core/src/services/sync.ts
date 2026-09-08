import type { Repos } from '../db/repos';
import type { EntityRepo } from '../db/repo';
import type { WriteContext } from '../db/repo';
import { SYNC_WRITE } from '../db/repo';
import type { SyncConflict, SyncOperation } from '../domain/types';
import type { SettingsService } from './settings';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';

const log = createLogger('sync');

/**
 * Sync engine (req. 14, 15, 59–62).
 *
 * Model: **incremental, entity-level, version-based, last-writer-with-review.**
 *  - every local mutation is already in `sync_queue` (written in the same transaction
 *    as the entity, so a crash cannot lose it);
 *  - push sends pending operations in priority order and marks them from the server acks;
 *  - pull fetches changes since a stored cursor and applies them entity by entity;
 *  - a conflict is resolved by rules, and every automatic resolution is written to
 *    `sync_conflicts` + `change_log` so nothing disappears without a trace;
 *  - critical entities (goals, strategy, profile facts, memories, settings) are never
 *    merged silently: they wait for the user's choice.
 */

export interface PushOperation {
  operation_id: string;
  entity_type: string;
  entity_id: string;
  operation_type: 'create' | 'update' | 'delete';
  base_version: number;
  version: number;
  payload: Record<string, unknown>;
  updated_at: string;
}

export interface PushAck {
  operation_id: string;
  status: 'applied' | 'conflict' | 'rejected';
  server_version?: number;
  remote_payload?: Record<string, unknown>;
  error?: string;
}

export interface RemoteChange {
  entity_type: string;
  entity_id: string;
  version: number;
  /** Version the remote change was based on, when the server tracks it. */
  base_version?: number;
  payload: Record<string, unknown>;
  deleted: boolean;
  updated_at: string;
  origin_device?: string | null;
  seq?: string | null;
}

export interface SyncTransport {
  push(operations: PushOperation[]): Promise<PushAck[]>;
  pull(cursor: string | null, limit: number): Promise<{ changes: RemoteChange[]; cursor: string | null }>;
  health?(): Promise<{ ok: boolean; serverTime?: string }>;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pushed: number;
  applied: number;
  pulled: number;
  merged: number;
  conflictsCreated: number;
  rejected: number;
  failed: number;
  offline: boolean;
  cursor: string | null;
  errors: string[];
}

export interface SyncStatusView {
  enabled: boolean;
  autoSync: boolean;
  serverUrl: string | null;
  pending: number;
  inFlight: number;
  failed: number;
  conflictsOpen: number;
  lastPushedAt: string | null;
  lastPulledCursor: string | null;
  lastError: string | null;
  running: boolean;
}

/** Entities whose content the user must never see change without asking (req. 15). */
export const CRITICAL_ENTITY_TYPES = new Set([
  'goal', 'strategy_item', 'profile_field', 'memory', 'setting', 'account', 'skill',
]);

const BOOKKEEPING = new Set(['created_at', 'updated_at', 'version', 'deleted', 'sync_state']);
const COMPLETION_VALUES = new Set(['done', 'completed', 'achieved', 'cancelled']);

export interface SyncDeps {
  repos: Repos;
  transport: SyncTransport;
  settings: SettingsService;
  deviceId: string;
  /** Called after a sync so the UI can refresh; also used for permanent rejections. */
  onEvent?: (event: SyncEvent) => void;
}

export type SyncEvent =
  | { type: 'started' }
  | { type: 'finished'; report: SyncReport }
  | { type: 'conflict'; conflict: SyncConflict; needsUser: boolean }
  | { type: 'rejected'; operation: SyncOperation; error: string }
  | { type: 'offline'; error: string };

const MAX_ATTEMPTS = 6;

export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastError: string | null = null;
  private backoffMs = 0;

  constructor(private readonly deps: SyncDeps) {}

  get isRunning(): boolean { return this.running; }

  // ─────────────────────────── public API ───────────────────────────
  async status(): Promise<SyncStatusView> {
    const settings = await this.deps.settings.all();
    const [pending, inFlight, failed, conflicts, cursor] = await Promise.all([
      this.deps.repos.syncQueue.count({ sync_status: { op: 'in', value: ['pending', 'conflict'] } }),
      this.deps.repos.syncQueue.count({ sync_status: 'in_flight' }),
      this.deps.repos.syncQueue.count({ sync_status: 'failed' }),
      this.deps.repos.syncConflicts.count({ resolved_at: null }),
      this.deps.repos.syncCursors.byId('*'),
    ]);
    const lastPush = await this.deps.repos.syncQueue.findOne({ sync_status: 'synchronized' }, { orderBy: { updated_at: 'desc' } });
    return {
      enabled: settings.sync.enabled,
      autoSync: settings.sync.auto_sync,
      serverUrl: settings.sync.server_url,
      pending, inFlight, failed,
      conflictsOpen: conflicts,
      lastPushedAt: lastPush?.updated_at ?? cursor?.last_pushed_at ?? null,
      lastPulledCursor: cursor?.last_pulled_seq ?? null,
      lastError: this.lastError,
      running: this.running,
    };
  }

  /** One full sync cycle: push local changes, then pull remote ones. */
  async syncOnce(options: { maxOperations?: number; force?: boolean } = {}): Promise<SyncReport> {
    const settings = await this.deps.settings.all();
    if (!settings.sync.enabled && !options.force) {
      return emptyReport({ errors: ['sync disabled in settings'] });
    }
    if (this.running) return emptyReport({ errors: ['sync already running'] });

    this.running = true;
    const startedAt = nowIso();
    const started = Date.now();
    const errors: string[] = [];
    let pushed = 0; let applied = 0; let pulled = 0; let merged = 0; let conflictsCreated = 0;
    let rejected = 0; let failed = 0; let offline = false; let cursor: string | null = null;
    this.deps.onEvent?.({ type: 'started' });

    try {
      const pushResult = await this.pushPending(options.maxOperations ?? 200);
      pushed = pushResult.sent; applied = pushResult.applied; merged += pushResult.merged;
      conflictsCreated += pushResult.conflicts; rejected = pushResult.rejected; failed = pushResult.failed;
      errors.push(...pushResult.errors);

      const pullResult = await this.pullChanges(options.maxOperations ?? 200);
      pulled = pullResult.applied; merged += pullResult.merged; conflictsCreated += pullResult.conflicts;
      failed += pullResult.failed; cursor = pullResult.cursor;
      errors.push(...pullResult.errors);
      offline = pullResult.offline || pushResult.offline;

      // A merge produces a new local version; push it in the same cycle so the other devices
      // converge now instead of on the next tick. Bounded to one extra pass.
      if (merged > 0 && !offline) {
        const repush = await this.pushPending(options.maxOperations ?? 200);
        pushed += repush.sent; applied += repush.applied; merged += repush.merged;
        conflictsCreated += repush.conflicts; rejected += repush.rejected; failed += repush.failed;
        errors.push(...repush.errors);
      }

      this.lastError = errors[0] ?? null;
      this.backoffMs = offline || errors.length ? nextBackoff(this.backoffMs) : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      offline = isOfflineError(error);
      this.lastError = message;
      this.backoffMs = nextBackoff(this.backoffMs);
      errors.push(message);
      if (offline) this.deps.onEvent?.({ type: 'offline', error: message });
      log.warn('sync failed', { error: message });
    } finally {
      this.running = false;
    }

    const report: SyncReport = {
      startedAt, finishedAt: nowIso(), durationMs: Date.now() - started,
      pushed, applied, pulled, merged, conflictsCreated, rejected, failed, offline, cursor, errors,
    };
    this.deps.onEvent?.({ type: 'finished', report });
    if (report.pushed || report.pulled || report.conflictsCreated) {
      log.info('sync cycle', { pushed: report.pushed, pulled: report.pulled, conflicts: report.conflictsCreated, ms: report.durationMs });
    }
    return report;
  }

  /** Send queued local operations to the server and apply the acks. */
  async pushPending(limit = 200): Promise<{
    sent: number; applied: number; merged: number; conflicts: number; rejected: number; failed: number; offline: boolean; errors: string[];
  }> {
    const out = { sent: 0, applied: 0, merged: 0, conflicts: 0, rejected: 0, failed: 0, offline: false, errors: [] as string[] };
    const queued = await this.deps.repos.syncQueue.find(
      { sync_status: { op: 'in', value: ['pending', 'conflict'] } },
      { orderBy: { priority: 'desc', created_at: 'asc' }, limit },
    );
    if (!queued.length) return out;

    const batch = queued.filter((op) => op.attempts < MAX_ATTEMPTS);
    if (!batch.length) {
      out.errors.push(`${queued.length} operations permanently rejected (see Sync status)`);
      return out;
    }

    const operations: PushOperation[] = [];
    for (const op of batch) {
      operations.push({
        operation_id: op.operation_id, entity_type: op.entity_type, entity_id: op.entity_id,
        operation_type: op.operation_type, base_version: Number(op.base_version), version: Number(op.version),
        payload: parsePayload(op.payload), updated_at: op.updated_at,
      });
      await this.mark(op.operation_id, 'in_flight');
    }
    out.sent = operations.length;

    let acks: PushAck[];
    try {
      acks = await this.deps.transport.push(operations);
    } catch (error) {
      out.offline = isOfflineError(error);
      const message = error instanceof Error ? error.message : String(error);
      out.errors.push(message);
      // Never acknowledged → back to pending with an attempt counted (req. 62).
      for (const op of batch) await this.failAttempt(op, message, 'pending');
      if (out.offline) this.deps.onEvent?.({ type: 'offline', error: message });
      return out;
    }

    const byId = new Map(batch.map((op) => [op.operation_id, op]));
    for (const ack of acks) {
      const op = byId.get(ack.operation_id);
      if (!op) continue;
      byId.delete(ack.operation_id);
      if (ack.status === 'applied') {
        await this.mark(op.operation_id, 'synchronized');
        await this.markEntitySynced(op.entity_type, op.entity_id, ack.server_version);
        await this.touchCursorPush();
        out.applied += 1;
        continue;
      }
      if (ack.status === 'conflict' && ack.remote_payload) {
        const resolution = await this.resolveWithRemote(op.entity_type, op.entity_id, ack.remote_payload, ack.server_version ?? op.version, op.base_version);
        await this.mark(op.operation_id, resolution.needsUser ? 'conflict' : 'synchronized');
        if (resolution.needsUser) out.conflicts += 1; else if (resolution.merged) out.merged += 1; else out.applied += 1;
        continue;
      }
      out.rejected += 1;
      await this.failAttempt(op, ack.error ?? 'rejected by server', 'failed');
      this.deps.onEvent?.({ type: 'rejected', operation: op, error: ack.error ?? 'rejected by server' });
    }

    // Operations the server never answered: keep them pending, count the attempt.
    for (const op of byId.values()) {
      await this.failAttempt(op, 'no acknowledgement from server', 'pending');
      out.failed += 1;
    }
    return out;
  }

  /** Fetch remote changes since the stored cursor and apply them. */
  async pullChanges(limit = 200): Promise<{ applied: number; merged: number; conflicts: number; failed: number; cursor: string | null; offline: boolean; errors: string[] }> {
    const out = { applied: 0, merged: 0, conflicts: 0, failed: 0, cursor: null as string | null, offline: false, errors: [] as string[] };
    const cursorRow = await this.deps.repos.syncCursors.byId('*');
    const cursor = cursorRow?.last_pulled_seq ?? null;

    let page: { changes: RemoteChange[]; cursor: string | null };
    try {
      page = await this.deps.transport.pull(cursor, limit);
    } catch (error) {
      out.offline = isOfflineError(error);
      const message = error instanceof Error ? error.message : String(error);
      out.errors.push(message);
      if (out.offline) this.deps.onEvent?.({ type: 'offline', error: message });
      return out;
    }

    out.cursor = page.cursor ?? cursor;
    for (const change of page.changes) {
      try {
        const result = await this.applyRemoteChange(change);
        if (result.needsUser) out.conflicts += 1;
        else if (result.merged) out.merged += 1;
        else out.applied += 1;
      } catch (error) {
        out.failed += 1;
        out.errors.push(`${change.entity_type}/${change.entity_id}: ${error instanceof Error ? error.message : String(error)}`);
        log.warn('failed to apply remote change', { entity: change.entity_type, id: change.entity_id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (page.cursor) {
      await this.deps.repos.syncCursors.insert(
        { entity_type: '*', last_pulled_seq: page.cursor, last_pushed_at: cursorRow?.last_pushed_at ?? null, updated_at: nowIso() } as never,
        { ...SYNC_WRITE, sync: false },
      ).catch(async () => {
        await this.deps.repos.syncCursors.update('*', { last_pulled_seq: page.cursor, updated_at: nowIso() } as never, { ...SYNC_WRITE, sync: false });
      });
    }
    return out;
  }

  /** Conflicts waiting for a human decision. */
  async openConflicts(): Promise<(SyncConflict & { local: Record<string, unknown>; remote: Record<string, unknown>; diff: FieldDiff[] })[]> {
    const rows = await this.deps.repos.syncConflicts.find({ resolved_at: null }, { orderBy: { detected_at: 'desc' }, limit: 100 });
    return rows.map((row) => {
      const local = parsePayload(row.local_payload);
      const remote = parsePayload(row.remote_payload);
      return { ...row, local, remote, diff: diffPayloads(local, remote) };
    });
  }

  /**
   * Apply the user's decision to a conflict. `merged` accepts a field-level patch
   * built in the UI from the side-by-side diff.
   */
  async resolveConflict(
    id: string,
    choice: 'local' | 'remote' | 'merged',
    options: { mergedPayload?: Record<string, unknown>; resolvedBy?: string } = {},
  ): Promise<{ resolved: true; entity_type: string; entity_id: string; choice: string }> {
    const conflict = await this.deps.repos.syncConflicts.byId(id);
    if (!conflict) throw AppError.notFound('sync conflict', id);
    const repo = this.repoFor(conflict.entity_type);

    if (choice === 'local') {
      // Local stays; tell the server by re-queueing the local state.
      await this.requeueLocal(conflict.entity_type, conflict.entity_id);
    } else {
      const payload = choice === 'merged'
        ? options.mergedPayload ?? mergePayloads(parsePayload(conflict.local_payload), parsePayload(conflict.remote_payload))
        : parsePayload(conflict.remote_payload);
      if (choice === 'merged') {
        // hand-merged values are new information for the server → push them
        await this.writeMerged(repo, conflict.entity_type, conflict.entity_id, payload, Number(conflict.server_version), `conflict ${id} resolved: user merge`);
      } else {
        await this.writeRemote(repo, conflict.entity_id, payload, conflict.server_version, `conflict ${id} resolved: ${choice}`);
      }
    }

    await this.deps.repos.syncConflicts.update(id, {
      resolution: choice === 'local' ? 'local_wins' : choice === 'remote' ? 'remote_wins' : 'user_choice',
      resolved_at: nowIso(), resolved_by: options.resolvedBy ?? 'user',
    } as never, { ...SYNC_WRITE, sync: false });
    await this.deps.repos.syncQueue.update(
      await this.queueIdFor(conflict.entity_type, conflict.entity_id) ?? '',
      { sync_status: 'synchronized', last_error: null } as never,
      { ...SYNC_WRITE, sync: false, audit: false },
    ).catch(() => undefined);

    return { resolved: true, entity_type: conflict.entity_type, entity_id: conflict.entity_id, choice };
  }

  /** Recovery helper: operations left `in_flight` by a crash were never acknowledged. */
  async resetInFlight(): Promise<number> {
    const stuck = await this.deps.repos.syncQueue.find({ sync_status: 'in_flight' }, { limit: 1000 });
    for (const op of stuck) {
      await this.deps.repos.syncQueue.update(op.operation_id, { sync_status: 'pending', updated_at: nowIso() } as never, { ...SYNC_WRITE, sync: false, audit: false });
    }
    if (stuck.length) log.info('reset in-flight sync operations after crash', { count: stuck.length });
    return stuck.length;
  }

  /** Drop everything queued and mark local data as local-only (used when the user signs out). */
  async clearQueue(): Promise<number> {
    const rows = await this.deps.repos.syncQueue.find({}, { limit: 5000 });
    for (const row of rows) await this.deps.repos.syncQueue.hardDelete(row.operation_id, { ...SYNC_WRITE, sync: false, audit: false });
    return rows.length;
  }

  // ─────────────────────────── scheduling ───────────────────────────
  /** Periodic auto-sync. Stops itself when the user disables sync in settings. */
  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.autoTick(); }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref(): void }).unref();
    void this.autoTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by the platform layer when connectivity returns (req. 60). */
  async notifyOnline(): Promise<SyncReport | null> {
    this.backoffMs = 0;
    return this.autoTick();
  }

  private async autoTick(): Promise<SyncReport | null> {
    const settings = await this.deps.settings.all();
    if (!settings.sync.enabled || !settings.sync.auto_sync) return null;
    if (this.backoffMs > 0) {
      this.backoffMs = Math.max(0, this.backoffMs - 30_000);
      if (this.backoffMs > 0) return null;
    }
    return this.syncOnce();
  }

  // ─────────────────────────── internals ───────────────────────────
  private repoFor(entityType: string): EntityRepo<object> {
    const repo = this.deps.repos.byEntityType(entityType);
    if (!repo) throw AppError.notFound('synced entity type', entityType);
    return repo;
  }

  private async mark(operationId: string, status: SyncOperation['sync_status']): Promise<void> {
    await this.deps.repos.syncQueue.update(operationId, { sync_status: status, updated_at: nowIso() } as never, { ...SYNC_WRITE, sync: false, audit: false });
  }

  private async failAttempt(op: SyncOperation, error: string, status: SyncOperation['sync_status']): Promise<void> {
    const attempts = Number(op.attempts) + 1;
    const permanent = status === 'failed' || attempts >= MAX_ATTEMPTS;
    await this.deps.repos.syncQueue.update(op.operation_id, {
      sync_status: permanent ? 'failed' : status,
      attempts, last_error: error.slice(0, 500), updated_at: nowIso(),
    } as never, { ...SYNC_WRITE, sync: false, audit: false });
    if (permanent) this.deps.onEvent?.({ type: 'rejected', operation: op, error });
  }

  private async markEntitySynced(entityType: string, entityId: string, serverVersion?: number): Promise<void> {
    const repo = this.deps.repos.byEntityType(entityType);
    if (!repo) return;
    const patch: Record<string, unknown> = { sync_state: 'synchronized' };
    if (serverVersion !== undefined) patch.version = serverVersion;
    await repo.update(entityId, patch as never, { ...SYNC_WRITE, sync: false, audit: false, keepVersion: serverVersion !== undefined });
  }

  private async touchCursorPush(): Promise<void> {
    const row = await this.deps.repos.syncCursors.byId('*');
    if (row) await this.deps.repos.syncCursors.update('*', { last_pushed_at: nowIso(), updated_at: nowIso() } as never, { ...SYNC_WRITE, sync: false, audit: false });
    else await this.deps.repos.syncCursors.insert({ entity_type: '*', last_pulled_seq: null, last_pushed_at: nowIso(), updated_at: nowIso() } as never, { ...SYNC_WRITE, sync: false, audit: false });
  }

  private async queueIdFor(entityType: string, entityId: string): Promise<string | null> {
    const row = await this.deps.repos.syncQueue.findOne(
      { entity_type: entityType, entity_id: entityId, sync_status: { op: 'in', value: ['pending', 'conflict', 'in_flight'] } },
      { orderBy: { created_at: 'desc' } },
    );
    return row?.operation_id ?? null;
  }

  /** Re-queue the current local state so the server learns the user's decision. */
  private async requeueLocal(entityType: string, entityId: string): Promise<void> {
    const repo = this.deps.repos.byEntityType(entityType);
    if (!repo) return;
    const local = await repo.byId(entityId, { includeDeleted: true });
    if (!local) return;
    const record = local as Record<string, unknown>;
    await this.deps.repos.syncQueue.insert({
      operation_id: newId('op'), entity_type: entityType, entity_id: entityId, operation_type: 'update',
      payload: JSON.stringify(record), base_version: Number(record.version ?? 1), version: Number(record.version ?? 1),
      priority: 10, device_id: this.deps.deviceId, attempts: 0, last_error: null, sync_status: 'pending',
      created_at: nowIso(), updated_at: nowIso(),
    } as never, { ...SYNC_WRITE, sync: false, audit: false });
  }

  /**
   * Apply one remote change. Returns whether it was applied cleanly, merged, or
   * parked as a conflict for the user.
   */
  private async applyRemoteChange(change: RemoteChange): Promise<{ applied: boolean; merged: boolean; needsUser: boolean }> {
    const repo = this.repoFor(change.entity_type);
    if (change.origin_device && change.origin_device === this.deps.deviceId) {
      return { applied: false, merged: false, needsUser: false }; // our own change echoed back
    }
    const local = (await repo.byId(change.entity_id, { includeDeleted: true })) as Record<string, unknown> | undefined;
    const remote = { ...change.payload, deleted: change.deleted ? 1 : 0 };

    if (!local) {
      await this.insertRemote(repo, change.entity_id, remote, change.version, `sync pull from ${change.origin_device ?? 'server'}`);
      return { applied: true, merged: false, needsUser: false };
    }

    const localVersion = Number(local.version ?? 0);

    // Already merged into a queued local version (typically during this cycle's push phase).
    if (await this.alreadyReconciled(change.entity_type, change.entity_id, change.version)) {
      return { applied: false, merged: false, needsUser: false };
    }

    const localDirty = local.sync_state === 'pending' || local.sync_state === 'conflict'
      || (await this.queueIdFor(change.entity_type, change.entity_id)) !== null;

    // No unsynced local edits, or the remote is strictly newer than our base → clean apply.
    if (!localDirty || localVersion <= (change.base_version ?? change.version - 1)) {
      await this.writeRemote(repo, change.entity_id, remote, change.version, `sync pull (v${localVersion} → v${change.version})`);
      return { applied: true, merged: false, needsUser: false };
    }

    return this.resolveWithRemote(change.entity_type, change.entity_id, remote, change.version, change.base_version ?? localVersion, local);
  }

  /**
   * Conflict rules from docs/04 §6. Critical entities always wait for the user;
   * everything else is resolved deterministically and recorded.
   */
  private async resolveWithRemote(
    entityType: string,
    entityId: string,
    remotePayload: Record<string, unknown>,
    serverVersion: number,
    baseVersion: number,
    localRow?: Record<string, unknown>,
  ): Promise<{ applied: boolean; merged: boolean; needsUser: boolean }> {
    const repo = this.repoFor(entityType);
    const local = (localRow ?? await repo.byId(entityId, { includeDeleted: true })) as Record<string, unknown> | undefined;
    const localVersion = Number(local?.version ?? 0);
    if (!local) {
      await this.insertRemote(repo, entityId, remotePayload, serverVersion, 'sync conflict: local missing');
      return { applied: true, merged: false, needsUser: false };
    }

    const base = await this.findBase(entityType, entityId);
    const critical = CRITICAL_ENTITY_TYPES.has(entityType);
    const remoteDeleted = Number(remotePayload.deleted ?? 0) === 1;
    const localDeleted = Number(local.deleted ?? 0) === 1;

    // Delete vs update: the delete wins, but the surviving payload is preserved.
    if (remoteDeleted !== localDeleted) {
      const conflict = await this.recordConflict(entityType, entityId, local, remotePayload, baseVersion, serverVersion, critical, 'delete');
      if (!critical) {
        await this.writeRemote(repo, entityId, remotePayload, serverVersion, 'sync: delete wins over update');
        await this.closeConflict(conflict.id, 'delete_wins');
        return { applied: true, merged: false, needsUser: false };
      }
      this.deps.onEvent?.({ type: 'conflict', conflict, needsUser: true });
      return { applied: false, merged: false, needsUser: true };
    }

    const localChanged = changedFields(base, local);
    const remoteChanged = changedFields(base, remotePayload);
    const overlap = localChanged.filter((field) => remoteChanged.includes(field));

    // Field-disjoint changes merge cleanly — both sides are kept.
    if (!overlap.length && base) {
      const mergedPayload = { ...local };
      for (const field of remoteChanged) mergedPayload[field] = remotePayload[field];
      await this.writeMerged(repo, entityType, entityId, mergedPayload, serverVersion, `sync: field-level merge onto server v${serverVersion} (local was v${localVersion})`);
      const conflict = await this.recordConflict(entityType, entityId, local, remotePayload, baseVersion, serverVersion, false, null);
      await this.closeConflict(conflict.id, 'merged');
      this.deps.onEvent?.({ type: 'conflict', conflict, needsUser: false });
      return { applied: false, merged: true, needsUser: false };
    }

    if (critical || !base) {
      const conflict = await this.recordConflict(entityType, entityId, local, remotePayload, baseVersion, serverVersion, critical, overlap[0] ?? null);
      await repo.update(entityId, { sync_state: 'conflict' } as never, { ...SYNC_WRITE, sync: false, audit: false, keepVersion: true });
      this.deps.onEvent?.({ type: 'conflict', conflict, needsUser: critical });
      return { applied: false, merged: false, needsUser: critical };
    }

    // Same field edited on both sides: completions win, otherwise the newer edit wins,
    // and the losing payload stays recoverable in sync_conflicts.
    const completionField = overlap.find((field) => field === 'status' && (
      COMPLETION_VALUES.has(String(local[field])) !== COMPLETION_VALUES.has(String(remotePayload[field]))
    ));
    const mergedPayload = { ...local };
    for (const field of overlap) {
      const localWins = completionField
        ? COMPLETION_VALUES.has(String(local[field]))
        : String(local.updated_at ?? '') >= String(remotePayload.updated_at ?? '');
      mergedPayload[field] = localWins ? local[field] : remotePayload[field];
    }
    const resolution = completionField ? 'merged' : String(local.updated_at ?? '') >= String(remotePayload.updated_at ?? '') ? 'local_wins' : 'remote_wins';
    await this.writeMerged(repo, entityType, entityId, mergedPayload, serverVersion, `sync conflict auto-resolved (${resolution}) onto server v${serverVersion}`);
    const conflict = await this.recordConflict(entityType, entityId, local, remotePayload, baseVersion, serverVersion, false, overlap[0] ?? null);
    await this.closeConflict(conflict.id, resolution as SyncConflict['resolution']);
    this.deps.onEvent?.({ type: 'conflict', conflict, needsUser: false });
    return { applied: false, merged: resolution === 'merged', needsUser: false };
  }

  /**
   * The last state both devices agreed on: the most recent sync-applied version of
   * this entity from the change journal. Without it a three-way merge is impossible
   * and the engine falls back to the timestamp rule (and says so in the conflict row).
   */
  private async findBase(entityType: string, entityId: string): Promise<Record<string, unknown> | null> {
    const entries = await this.deps.repos.changeLog.find(
      { entity_type: entityType, entity_id: entityId, actor: { op: 'in', value: ['sync', 'import'] } },
      { orderBy: { at: 'desc' }, limit: 1 },
    );
    const raw = entries[0]?.after_json;
    return raw ? parsePayload(raw) : null;
  }

  private async recordConflict(
    entityType: string, entityId: string,
    local: Record<string, unknown>, remote: Record<string, unknown>,
    baseVersion: number, serverVersion: number, critical: boolean, field: string | null,
  ): Promise<SyncConflict> {
    // One OPEN row per entity: the same entity can collide on push and again on pull in the same
    // cycle, and stacking duplicates would make the user resolve one decision several times.
    const existing = await this.deps.repos.syncConflicts.findOne(
      { entity_type: entityType, entity_id: entityId, resolution: null },
      { orderBy: { detected_at: 'desc' } },
    );
    if (existing) {
      const refreshed = await this.deps.repos.syncConflicts.update(existing.id, {
        local_payload: JSON.stringify(local), remote_payload: JSON.stringify(remote),
        base_version: baseVersion, server_version: serverVersion, critical: critical ? 1 : 0,
        field: field ?? existing.field, detected_at: nowIso(),
      } as never, { ...SYNC_WRITE, sync: false, audit: false });
      return (refreshed ?? existing) as SyncConflict;
    }
    return this.deps.repos.syncConflicts.insert({
      id: newId(), entity_type: entityType, entity_id: entityId, field,
      local_payload: JSON.stringify(local), remote_payload: JSON.stringify(remote),
      base_version: baseVersion, server_version: serverVersion, critical: critical ? 1 : 0,
      resolution: null, resolved_at: null, resolved_by: null, detected_at: nowIso(), created_at: nowIso(),
    } as never, { ...SYNC_WRITE, sync: false }) as Promise<SyncConflict>;
  }

  private async closeConflict(id: string, resolution: SyncConflict['resolution']): Promise<void> {
    await this.deps.repos.syncConflicts.update(id, { resolution, resolved_at: nowIso(), resolved_by: 'engine' } as never, { ...SYNC_WRITE, sync: false, audit: false });
  }

  private async writeRemote(repo: EntityRepo<object>, entityId: string, payload: Record<string, unknown>, version: number, reason: string): Promise<void> {
    const { id: _id, ...patch } = payload;
    await repo.update(entityId, {
      ...patch, version, sync_state: 'synchronized',
    } as never, { ...SYNC_WRITE, sync: false, audit: true, keepVersion: true, reason, deviceId: this.deps.deviceId });
  }

  /**
   * Store an auto-resolved or user-merged state as a NEW version and queue it for push.
   *
   * A merge that stays local would leave the two devices permanently diverged (each convinced it
   * is synchronized), so the merged payload always travels back to the server with
   * `base_version = serverVersion`.
   */
  private async writeMerged(
    repo: EntityRepo<object>, entityType: string, entityId: string,
    mergedPayload: Record<string, unknown>, serverVersion: number, reason: string,
  ): Promise<void> {
    const { id: _id, ...patch } = mergedPayload;
    const version = serverVersion + 1;
    await repo.update(entityId, {
      ...patch, version, sync_state: 'pending', updated_at: nowIso(),
    } as never, { actor: 'sync', sync: false, audit: true, keepVersion: true, reason, deviceId: this.deps.deviceId });

    // Retire whatever was queued for this entity: the merged state supersedes it, and pushing the
    // old operation as well would make the server see a stale base_version and conflict again.
    const superseded = await this.deps.repos.syncQueue.find(
      { entity_type: entityType, entity_id: entityId, sync_status: { op: 'in', value: ['pending', 'conflict', 'in_flight'] } },
      { limit: 50 },
    );
    for (const op of superseded) {
      await this.deps.repos.syncQueue.update(op.operation_id, { sync_status: 'synchronized', last_error: null } as never, { ...SYNC_WRITE, sync: false, audit: false });
    }

    await this.deps.repos.syncQueue.insert({
      operation_id: newId('op'), entity_type: entityType, entity_id: entityId, operation_type: 'update',
      payload: JSON.stringify({ ...mergedPayload, version }), base_version: serverVersion, version,
      priority: repo.syncPriority ?? 5, device_id: this.deps.deviceId, attempts: 0, last_error: null,
      sync_status: 'pending', created_at: nowIso(), updated_at: nowIso(),
    } as never, { ...SYNC_WRITE, sync: false, audit: false });
  }

  /**
   * True when a queued local operation already builds on this server version — the change was
   * merged during the push phase of the same cycle (or is a duplicate delivery). Re-resolving it
   * would read our own merge as "the other side changed it back" and resurrect stale values.
   */
  private async alreadyReconciled(entityType: string, entityId: string, serverVersion: number): Promise<boolean> {
    const op = await this.deps.repos.syncQueue.findOne(
      { entity_type: entityType, entity_id: entityId, sync_status: { op: 'in', value: ['pending', 'conflict', 'in_flight'] } },
      { orderBy: { created_at: 'desc' } },
    );
    return op !== undefined && Number(op.base_version) >= serverVersion;
  }

  private async insertRemote(repo: EntityRepo<object>, entityId: string, payload: Record<string, unknown>, version: number, reason: string): Promise<void> {
    await repo.insert({ ...payload, version, sync_state: 'synchronized' } as never, {
      ...SYNC_WRITE, sync: false, audit: true, reason, deviceId: this.deps.deviceId,
    });
    void entityId;
  }
}

// ─────────────────────────── pure helpers ───────────────────────────
export interface FieldDiff { field: string; local: unknown; remote: unknown }

export function diffPayloads(local: Record<string, unknown>, remote: Record<string, unknown>): FieldDiff[] {
  const fields = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const out: FieldDiff[] = [];
  for (const field of fields) {
    if (BOOKKEEPING.has(field)) continue;
    const a = local[field]; const b = remote[field];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push({ field, local: a ?? null, remote: b ?? null });
  }
  return out;
}

function changedFields(base: Record<string, unknown> | null, next: Record<string, unknown>): string[] {
  if (!base) return Object.keys(next).filter((k) => !BOOKKEEPING.has(k));
  const out: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (BOOKKEEPING.has(key)) continue;
    if (JSON.stringify(base[key] ?? null) !== JSON.stringify(value ?? null)) out.push(key);
  }
  return out;
}

export function mergePayloads(local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...local };
  for (const [key, value] of Object.entries(remote)) {
    if (BOOKKEEPING.has(key)) continue;
    if (merged[key] === undefined || merged[key] === null) merged[key] = value;
  }
  return merged;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function isOfflineError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'network' || error.code === 'unauthorized';
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|econnrefused|enotfound|timeout|abort/i.test(message);
}

function nextBackoff(current: number): number {
  const next = current <= 0 ? 30_000 : Math.min(30 * 60_000, current * 2);
  return next + Math.round(Math.random() * 5_000);
}

function emptyReport(extra: Partial<SyncReport> = {}): SyncReport {
  const at = nowIso();
  return {
    startedAt: at, finishedAt: at, durationMs: 0, pushed: 0, applied: 0, pulled: 0, merged: 0,
    conflictsCreated: 0, rejected: 0, failed: 0, offline: false, cursor: null, errors: [], ...extra,
  };
}

/**
 * HTTP transport for the LifeMentor server. Tokens come from the auth service —
 * the client never stores provider keys, only its own session (req. 20, 58).
 */
export interface HttpSyncTransportConfig {
  serverUrl: string;
  getToken: () => Promise<string | null>;
  deviceId: string;
  timeoutMs?: number;
}

export class HttpSyncTransport implements SyncTransport {
  constructor(private readonly config: HttpSyncTransportConfig) {}

  private get baseUrl(): string { return this.config.serverUrl.replace(/\/$/, ''); }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.config.getToken();
    if (!token) throw AppError.unauthorized('Sync needs a signed-in account');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': this.config.deviceId,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401) throw AppError.unauthorized('Sync session expired');
        throw new AppError('network', `Sync request failed (${response.status})`, { details: text.slice(0, 300) });
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.network('Cannot reach the sync server', { cause: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  async push(operations: PushOperation[]): Promise<PushAck[]> {
    const result = await this.request<{ results?: PushAck[] }>('/v1/sync/push', {
      method: 'POST', body: JSON.stringify({ device_id: this.config.deviceId, operations }),
    });
    return result.results ?? [];
  }

  async pull(cursor: string | null, limit: number): Promise<{ changes: RemoteChange[]; cursor: string | null }> {
    const params = new URLSearchParams({ limit: String(limit), device_id: this.config.deviceId });
    if (cursor) params.set('since', cursor);
    const result = await this.request<{ changes?: RemoteChange[]; cursor?: string | null }>(`/v1/sync/pull?${params.toString()}`);
    return { changes: result.changes ?? [], cursor: result.cursor ?? cursor };
  }

  async health(): Promise<{ ok: boolean; serverTime?: string }> {
    try {
      const result = await this.request<{ ok?: boolean; time?: string }>('/v1/health');
      return { ok: result.ok !== false, serverTime: result.time };
    } catch {
      return { ok: false };
    }
  }
}

export type { WriteContext };
