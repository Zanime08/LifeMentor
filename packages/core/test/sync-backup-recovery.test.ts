import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { MemoryBackupStorage, NodeBackupStorage } from '../src/platform/storage';
import { EXPORT_FORMAT_VERSION, type ExportArchive } from '../src/services/backup';
import type { PushAck, PushOperation, RemoteChange, SyncTransport } from '../src/services/sync';
import { CRITICAL_ENTITY_TYPES, diffPayloads, mergePayloads } from '../src/services/sync';
import { nowIso } from '../src/util/time';

/**
 * Phase gate for persistence, sync, backup and recovery (req. 8–16, 54–56, 59–62, 94).
 *
 * The "server" here is a test double implementing the real transport contract, so the
 * client-side engine is exercised exactly as it runs in production: push acks, pull
 * cursors, version conflicts and offline behaviour.
 */

// ─────────────────────────── fake sync server ───────────────────────────
interface StoredEntity {
  entity_type: string;
  entity_id: string;
  version: number;
  payload: Record<string, unknown>;
  deleted: boolean;
  updated_at: string;
  origin_device: string;
  seq: number;
}

class FakeSyncServer {
  private readonly entities = new Map<string, StoredEntity>();
  private readonly feed: StoredEntity[] = [];
  private seq = 0;
  offline = false;

  private key(type: string, id: string): string { return `${type}:${id}`; }

  private failIfOffline(): void {
    if (this.offline) {
      const error = new Error('fetch failed: ECONNREFUSED');
      (error as Error & { code?: string }).code = 'network';
      throw error;
    }
  }

  push(operations: PushOperation[], deviceId: string): PushAck[] {
    this.failIfOffline();
    const acks: PushAck[] = [];
    for (const operation of operations) {
      const key = this.key(operation.entity_type, operation.entity_id);
      const existing = this.entities.get(key);
      if (!existing) {
        this.store(operation, deviceId, false);
        acks.push({ operation_id: operation.operation_id, status: 'applied', server_version: operation.version });
        continue;
      }
      if (operation.base_version >= existing.version) {
        this.store(operation, deviceId, operation.operation_type === 'delete');
        acks.push({ operation_id: operation.operation_id, status: 'applied', server_version: this.entities.get(key)!.version });
        continue;
      }
      acks.push({
        operation_id: operation.operation_id,
        status: 'conflict',
        server_version: existing.version,
        remote_payload: { ...existing.payload, deleted: existing.deleted ? 1 : 0 },
      });
    }
    return acks;
  }

  pull(since: string | null, limit: number, deviceId: string): { changes: RemoteChange[]; cursor: string | null } {
    this.failIfOffline();
    const from = since ? Number(since) : 0;
    const foreign = this.feed.filter((entry) => entry.seq > from && entry.origin_device !== deviceId);
    const slice = foreign.slice(0, limit);
    const changes: RemoteChange[] = slice.map((entry) => ({
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      version: entry.version,
      base_version: Math.max(0, entry.version - 1),
      payload: entry.payload,
      deleted: entry.deleted,
      updated_at: entry.updated_at,
      origin_device: entry.origin_device,
      seq: String(entry.seq),
    }));
    // A real server advances the caller's cursor even when nothing new is for that device.
    const cursor = slice.length ? String(slice[slice.length - 1].seq) : String(this.seq);
    return { changes, cursor };
  }

  private store(operation: PushOperation, deviceId: string, deleted: boolean): void {
    this.seq += 1;
    const entry: StoredEntity = {
      entity_type: operation.entity_type,
      entity_id: operation.entity_id,
      version: Math.max(operation.version, (this.entities.get(this.key(operation.entity_type, operation.entity_id))?.version ?? 0) + (deleted ? 1 : 0)),
      payload: operation.payload,
      deleted,
      updated_at: operation.updated_at ?? nowIso(),
      origin_device: deviceId,
      seq: this.seq,
    };
    this.entities.set(this.key(operation.entity_type, operation.entity_id), entry);
    this.feed.push(entry);
  }

  get(type: string, id: string): StoredEntity | undefined { return this.entities.get(this.key(type, id)); }
  get size(): number { return this.entities.size; }
  get feedSize(): number { return this.feed.length; }
}

function transportFor(server: FakeSyncServer, deviceId: string): SyncTransport {
  return {
    push: async (operations) => server.push(operations, deviceId),
    pull: async (cursor, limit) => server.pull(cursor, limit, deviceId),
  };
}

// ─────────────────────────── harness ───────────────────────────
let dir: string;
let opened = 0;
const lastPaths: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifementor-sync-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Each test opens fresh database files: a fake server starts its change feed at seq 1, so a device
 * that still holds a cursor from a previous test would skip real changes.
 */
async function openDevice(
  deviceId: string,
  options: { server?: FakeSyncServer; storage?: MemoryBackupStorage; name?: string } = {},
): Promise<LifeMentorApp> {
  opened += 1;
  const path = join(dir, `${options.name ?? deviceId}-${opened}.sqlite`);
  lastPaths[deviceId] = path;
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path, durability: 'paranoid' },
    deviceId,
    deviceName: deviceId,
    backup: { storage: options.storage ?? new MemoryBackupStorage(), onFirstLaunch: false },
    sync: options.server ? { transport: transportFor(options.server, deviceId), autoStart: false } : undefined,
    recover: false,
    // These tests are about sync and backup semantics; the background maintenance pass (which may
    // take its own automatic backup) is exercised in its own file with its own clock.
    maintenance: { enabled: false },
  });
}

describe('sync engine', () => {
  it('pushes local changes and pulls them onto a second device', async () => {
    const server = new FakeSyncServer();
    const a = await openDevice('device-a', { server });
    const b = await openDevice('device-b', { server });

    const goal = await a.services.goals.create({ title: 'Ship the mobile release', horizon: 'medium', priority: 'P1' });
    const task = await a.services.tasks.create({ title: 'Write release checklist', estimated_minutes: 40, goal_id: goal.id });

    const statusBefore = await a.services.sync!.status();
    expect(statusBefore.pending).toBeGreaterThanOrEqual(2);

    const pushed = await a.services.sync!.syncOnce();
    expect(pushed.pushed).toBeGreaterThanOrEqual(2);
    expect(pushed.applied).toBeGreaterThanOrEqual(2);
    expect(pushed.offline).toBe(false);
    expect(server.get('goal', goal.id)?.payload.title).toBe('Ship the mobile release');

    const pulled = await b.services.sync!.syncOnce();
    expect(pulled.pulled).toBeGreaterThanOrEqual(2);

    const remoteGoal = await b.services.goals.get(goal.id);
    expect(remoteGoal?.title).toBe('Ship the mobile release');
    expect(remoteGoal?.sync_state).toBe('synchronized');
    const remoteTask = await b.services.tasks.get(task.id);
    expect(remoteTask?.title).toBe('Write release checklist');

    // nothing is left queued on either side
    expect((await a.services.sync!.status()).pending).toBe(0);
    expect((await b.services.sync!.status()).pending).toBe(0);

    await a.close();
    await b.close();
  });

  it('merges field-disjoint edits from two devices', async () => {
    const server = new FakeSyncServer();
    const a = await openDevice('device-a', { server });
    const b = await openDevice('device-b', { server });

    const task = await a.services.tasks.create({ title: 'Prepare the demo', estimated_minutes: 30, notes: 'original' });
    await a.services.sync!.syncOnce();
    await b.services.sync!.syncOnce();

    // A changes the notes, B changes the estimate — different fields
    await a.services.tasks.update(task.id, { notes: 'updated on desktop' });
    await a.services.sync!.syncOnce();

    await b.services.tasks.update(task.id, { estimated_minutes: 55 });
    const report = await b.services.sync!.syncOnce();
    expect(report.errors).toEqual([]);

    await a.services.sync!.syncOnce();
    const merged = await a.services.tasks.get(task.id);
    expect(merged?.notes).toBe('updated on desktop');
    expect(merged?.estimated_minutes).toBe(55);
    expect((await a.services.sync!.openConflicts()).filter((c) => c.resolution === null)).toHaveLength(0);

    await a.close();
    await b.close();
  });

  it('never merges a critical entity silently — it waits for the user', async () => {
    expect(CRITICAL_ENTITY_TYPES.has('goal')).toBe(true);
    const server = new FakeSyncServer();
    const a = await openDevice('device-a', { server });
    const b = await openDevice('device-b', { server });

    const goal = await a.services.goals.create({ title: 'Learn Spanish', horizon: 'long', priority: 'P1' });
    await a.services.sync!.syncOnce();
    await b.services.sync!.syncOnce();

    await a.services.goals.update(goal.id, { title: 'Learn Spanish to B2' });
    await a.services.sync!.syncOnce();

    await b.services.goals.update(goal.id, { title: 'Learn Portuguese instead' });
    const events: string[] = [];
    const report = await b.services.sync!.syncOnce();
    expect(report.conflictsCreated).toBeGreaterThanOrEqual(1);
    events.push(...report.errors);

    const conflicts = await b.services.sync!.openConflicts();
    const open = conflicts.filter((c) => c.entity_id === goal.id && !c.resolved_at);
    expect(open.length).toBe(1);
    expect(open[0].critical).toBe(1);
    expect(open[0].diff.some((d) => d.field === 'title')).toBe(true);

    // local value is untouched while the decision is pending
    expect((await b.services.goals.get(goal.id))?.title).toBe('Learn Portuguese instead');

    // the user picks the remote version
    await b.services.sync!.resolveConflict(open[0].id, 'remote');
    expect((await b.services.goals.get(goal.id))?.title).toBe('Learn Spanish to B2');
    const after = await b.services.sync!.openConflicts();
    expect(after.filter((c) => c.entity_id === goal.id && !c.resolved_at)).toHaveLength(0);

    await a.close();
    await b.close();
  });

  it('keeps queued operations when the network is down and flushes them later', async () => {
    const server = new FakeSyncServer();
    const a = await openDevice('device-a', { server });
    await a.services.goals.create({ title: 'Offline goal', horizon: 'short' });

    server.offline = true;
    const offlineReport = await a.services.sync!.syncOnce();
    expect(offlineReport.offline).toBe(true);
    expect(offlineReport.applied).toBe(0);
    expect((await a.services.sync!.status()).pending).toBeGreaterThanOrEqual(1);

    server.offline = false;
    const online = await a.services.sync!.notifyOnline();
    expect(online?.applied).toBeGreaterThanOrEqual(1);
    expect((await a.services.sync!.status()).pending).toBe(0);
    expect(server.size).toBeGreaterThanOrEqual(1);

    await a.close();
  });

  it('resets operations left in flight by a crash', async () => {
    const server = new FakeSyncServer();
    const a = await openDevice('device-a', { server });
    const task = await a.services.tasks.create({ title: 'Crash during sync', estimated_minutes: 10 });
    await a.repos.db.run(`UPDATE sync_queue SET sync_status = 'in_flight' WHERE entity_id = ?`, [task.id]);

    const stuck = await a.repos.syncQueue.count({ sync_status: 'in_flight' });
    expect(stuck).toBeGreaterThan(0);

    const recovery = await a.services.recovery.startup();
    const resetAction = recovery.actions.find((action) => action.step === 'sync queue');
    expect(resetAction?.status).toBe('repaired');
    expect(await a.repos.syncQueue.count({ sync_status: 'in_flight' })).toBe(0);
    expect(await a.repos.syncQueue.count({ sync_status: 'pending' })).toBeGreaterThan(0);

    // and the data still reaches the server afterwards
    const report = await a.services.sync!.syncOnce();
    expect(report.applied).toBeGreaterThanOrEqual(1);
    expect(server.get('task', task.id)).toBeTruthy();

    await a.close();
  });

  it('pure helpers: diff and merge ignore bookkeeping columns', () => {
    const local = { id: 'x', title: 'Local', notes: 'same', version: 3, updated_at: '2026-01-02T00:00:00Z' };
    const remote = { id: 'x', title: 'Remote', notes: 'same', version: 5, updated_at: '2026-01-03T00:00:00Z' };
    const diff = diffPayloads(local, remote);
    expect(diff.map((d) => d.field)).toEqual(['title']);
    const merged = mergePayloads(local, remote);
    expect(merged.title).toBe('Local'); // merge only fills gaps
    expect(merged.notes).toBe('same');
  });
});

describe('backup and restore', () => {
  it('writes a real SQLite image, verifies it and restores from it', async () => {
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });
    const goal = await app.services.goals.create({ title: 'Before the disaster', horizon: 'long' });

    const backup = await app.services.backup.createBackup('manual', 'test backup');
    expect(backup.status).toBe('ok');
    expect(backup.size_bytes).toBeGreaterThan(1000);
    expect(backup.checksum?.length).toBeGreaterThan(10);
    const files = await storage.list();
    expect(files.length).toBe(1);
    expect(existsSync(lastPaths['device-a'])).toBe(true);

    const verified = await app.services.backup.verify(backup.id);
    expect(verified.ok).toBe(true);

    // destroy data, then restore
    await app.services.goals.update(goal.id, { title: 'Renamed after the backup' });
    expect((await app.services.goals.get(goal.id))?.title).toBe('Renamed after the backup');

    const restored = await app.services.backup.restore(backup.id);
    expect(restored.ok).toBe(true);
    expect(restored.integrityOk).toBe(true);
    const afterRestore = await app.services.goals.list({});
    expect(afterRestore.some((g) => g.title === 'Before the disaster')).toBe(true);
    expect(afterRestore.some((g) => g.title === 'Renamed after the backup')).toBe(false);

    await app.close();
  });

  it('refuses to restore a corrupted file', async () => {
    const backupDir = join(dir, 'corrupt-backups');
    const app = await openDevice('device-corrupt', { storage: new NodeBackupStorage({ directory: backupDir }) as unknown as MemoryBackupStorage });
    await app.services.goals.create({ title: 'Keep me', horizon: 'short' });
    const backup = await app.services.backup.createBackup('manual');
    expect(readdirSync(backupDir).length).toBe(1);

    // flip bytes in the middle of the file
    const file = join(backupDir, readdirSync(backupDir)[0]);
    const bytes = readFileSync(file);
    bytes.fill(0, 2048, 4096);
    writeFileSync(file, bytes);

    const verified = await app.services.backup.verify(backup.id);
    expect(verified.ok).toBe(false);
    await expect(app.services.backup.restore(backup.id)).rejects.toThrow(/integrity|checksum/i);
    // current data untouched
    expect((await app.services.goals.list({})).length).toBe(1);

    await app.close();
  });

  it('rotates backups keeping 7 daily, 4 weekly and 3 monthly', async () => {
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });
    // fabricate history directly in the backups table (no fake files needed for rotation logic)
    const dates = [
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
      '2025-12-01', '2025-11-01', '2025-10-01', '2025-09-01',
    ];
    for (const [index, date] of dates.entries()) {
      await app.repos.backups.insert({
        id: `backup_seed_${index}`, kind: 'auto', format: 'sqlite', path: `seed-${index}.sqlite`,
        checksum: null, size_bytes: 10, entity_counts: null, note: null, status: 'ok',
        created_at: `${date}T10:00:00.000Z`,
      } as never, { actor: 'system', sync: false, audit: false });
    }
    const result = await app.services.backup.rotate();
    const kept = await app.services.backup.list();
    expect(kept.length).toBe(result.kept);
    // 7 newest daily (Jan 3–9) + the newest of each of the 4 most recent weeks (Dec 1, Nov 1)
    expect(result.kept).toBe(9);
    expect(result.removed).toBe(4);
    const days = kept.map((b) => b.created_at.slice(0, 10));
    expect(days).toContain('2026-01-09');
    expect(days).toContain('2026-01-03');
    expect(days).not.toContain('2026-01-01'); // beyond the 7 daily slots
    expect(days).toContain('2025-12-01'); // kept by the weekly bucket
    expect(days).toContain('2025-11-01'); // kept by the monthly bucket
    expect(days).not.toContain('2025-09-01'); // older than 3 monthly slots

    await app.close();
  });

  it('keeps a manual backup taken right after a scheduled one (no same-day rotation loss)', async () => {
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });

    const scheduled = await app.services.backup.createBackup('auto', 'scheduled copy');
    const manual = await app.services.backup.createBackup('manual', 'user copy');

    const kept = await app.services.backup.list();
    expect(kept.map((b) => b.id)).toEqual(expect.arrayContaining([scheduled.id, manual.id]));
    expect(await app.services.backup.verify(manual.id)).toMatchObject({ ok: true });
    expect((await storage.list()).length).toBe(2);

    await app.close();
  });
});

describe('export and import', () => {
  it('exports a portable archive with a manifest and checksum', async () => {
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });
    await app.services.goals.create({ title: 'Exported goal', horizon: 'medium' });
    await app.services.tasks.create({ title: 'Exported task', estimated_minutes: 25 });

    const archive = await app.services.backup.exportArchive();
    expect(archive.manifest.format_version).toBe(EXPORT_FORMAT_VERSION);
    expect(archive.manifest.schema_version).toBeGreaterThan(0);
    expect(archive.manifest.counts.goal).toBeGreaterThanOrEqual(1);
    expect(archive.manifest.counts.task).toBeGreaterThanOrEqual(1);
    expect(archive.manifest.checksum.length).toBeGreaterThan(10);
    expect(archive.data.goal.some((row) => row.title === 'Exported goal')).toBe(true);

    const written = await app.services.backup.exportToFile();
    expect(written.bytes).toBeGreaterThan(500);
    const parsed = await app.services.backup.parseArchive(JSON.stringify(archive));
    expect(parsed.manifest.entities.length).toBeGreaterThan(5);

    await app.close();
  });

  it('imports into a fresh install and previews the diff before writing', async () => {
    const sourceStorage = new MemoryBackupStorage();
    const source = await openDevice('device-source', { storage: sourceStorage });
    const goal = await source.services.goals.create({ title: 'Move to Berlin', horizon: 'long', priority: 'P1' });
    await source.services.tasks.create({ title: 'Look at apartments', estimated_minutes: 60, goal_id: goal.id });
    await source.services.memory.save({ kind: 'fact', content: 'The user speaks German at B1 level', importance: 0.8 });
    const archive: ExportArchive = await source.services.backup.exportArchive();
    await source.close();

    const target = await openDevice('device-target');

    const preview = await target.services.backup.previewImport(archive);
    expect(preview.valid).toBe(true);
    expect(preview.totals.create).toBeGreaterThan(3);
    expect(preview.entities.find((e) => e.entity_type === 'goal')?.create).toBe(1);
    expect(preview.entities.find((e) => e.entity_type === 'task')?.create).toBe(1);

    const report = await target.services.backup.importArchive(archive, 'merge');
    expect(report.applied).toBe(true);
    expect(report.integrityOk).toBe(true);
    expect(report.backup_id).toBeTruthy(); // a pre-import backup was taken

    expect((await target.services.goals.get(goal.id))?.title).toBe('Move to Berlin');
    const tasks = await target.services.tasks.backlog(50);
    expect(tasks.some((t) => t.title === 'Look at apartments')).toBe(true);
    const memories = await target.services.memory.list({ limit: 50 });
    expect(memories.some((m) => /German at B1/.test(m.content))).toBe(true);

    // importing the same archive again changes nothing (idempotent merge)
    const second = await target.services.backup.previewImport(archive);
    expect(second.totals.create).toBe(0);

    await target.close();
  });

  it('rejects an archive from a much newer format', async () => {
    const app = await openDevice('device-a');
    const bad = JSON.stringify({ manifest: { format_version: 99, counts: {} }, data: {} });
    await expect(app.services.backup.parseArchive(bad)).rejects.toThrow(/newer/i);
    await app.close();
  });

  it('deletes all user data on account deletion, exporting first', async () => {
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });
    await app.services.goals.create({ title: 'Will be deleted', horizon: 'short' });
    await app.services.tasks.create({ title: 'Also deleted', estimated_minutes: 15 });
    await app.services.memory.save({ kind: 'fact', content: 'A private fact', importance: 0.9 });

    const result = await app.services.backup.deleteAllUserData({ exportFirst: true });
    expect(result.deletedTables).toBeGreaterThan(20);
    expect(result.rows).toBeGreaterThan(0);
    expect(result.exported).toBeTruthy();

    expect(await app.services.goals.list({ includeArchived: true })).toHaveLength(0);
    expect(await app.services.tasks.backlog(100)).toHaveLength(0);
    expect(await app.services.memory.list({ limit: 100 })).toHaveLength(0);

    // the export still holds the data — deletion is reversible by import
    const files = await storage.list();
    const exported = files.find((f) => f.name.startsWith('LifeMentor-export'));
    expect(exported).toBeTruthy();

    await app.close();
  });
});

describe('recovery', () => {
  it('runs the whole startup sequence on a healthy database', async () => {
    const app = await openDevice('device-a');
    await app.services.recovery.saveDraft('new-task', { title: 'half typed task' });
    await app.services.recovery.setLastRoute('/today');
    const task = await app.services.tasks.create({ title: 'Left running', estimated_minutes: 20 });
    await app.services.tasks.start(task.id);
    // a repo write always stamps `updated_at = now`, so the crash is simulated at the SQL level
    await app.repos.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [new Date(Date.now() - 6 * 3600_000).toISOString(), task.id]);

    const report = await app.services.recovery.startup();
    expect(report.ok).toBe(true);
    expect(report.integrity?.ok).toBe(true);
    const steps = report.actions.map((a) => a.step);
    for (const expected of ['integrity check', 'schema version', 'sync queue', 'app state', 'in-progress tasks', 'daily snapshot']) {
      expect(steps, `missing step ${expected}`).toContain(expected);
    }
    expect(report.state.drafts['new-task']).toEqual({ title: 'half typed task' });
    expect(report.state.lastRoute).toBe('/today');

    // the stale in-progress task is reported, not silently reset
    const stale = report.issues.find((i) => i.kind === 'stale_task');
    expect(stale).toBeTruthy();
    expect((await app.services.tasks.get(task.id))?.status).toBe('in_progress');

    // drafts can be cleared once the UI has restored them
    await app.services.recovery.clearDraft('new-task');
    expect(await app.services.recovery.readDraft('new-task')).toBeNull();

    await app.close();
  });

  it('quarantines orphan rows and keeps them in the change journal', async () => {
    const app = await openDevice('device-a');
    const goal = await app.services.goals.create({ title: 'Parent goal', horizon: 'medium' });
    const task = await app.services.tasks.create({ title: 'Child task', estimated_minutes: 30, goal_id: goal.id });

    // delete the parent with FK enforcement off — exactly what a corrupted file looks like
    await app.repos.db.exec('PRAGMA foreign_keys = OFF');
    await app.repos.db.run('DELETE FROM goals WHERE id = ?', [goal.id]);
    await app.repos.db.exec('PRAGMA foreign_keys = ON');

    const violations = await app.repos.db.all('PRAGMA foreign_key_check');
    expect(violations.length).toBeGreaterThan(0);

    const report = await app.services.recovery.startup();
    expect(report.ok).toBe(true);
    const repair = report.actions.find((a) => a.step === 'foreign-key repair');
    expect(repair?.status).toBe('repaired');
    expect(repair?.count).toBeGreaterThan(0);

    // the orphan is gone, but its content is preserved in the journal
    expect(await app.services.tasks.get(task.id)).toBeNull();
    const journal = await app.repos.changeLog.find({ entity_id: task.id, action: 'delete' }, { orderBy: { at: 'desc' }, limit: 5 });
    const quarantined = journal.find((entry) => /quarantined orphan/.test(entry.reason ?? ''));
    expect(quarantined).toBeTruthy();
    expect(quarantined?.before_json).toContain('Child task');

    // and the database is consistent again
    expect((await app.repos.db.integrityCheck()).ok).toBe(true);
    expect(await app.repos.db.all('PRAGMA foreign_key_check')).toHaveLength(0);

    await app.close();
  });

  it('diagnose() reports counts and sync backlog without changing anything', async () => {
    const server = new FakeSyncServer();
    const app = await openDevice('device-a', { server });
    await app.services.goals.create({ title: 'Diagnose me', horizon: 'short' });

    const diagnostics = await app.services.recovery.diagnose();
    expect(diagnostics.integrity.ok).toBe(true);
    expect(diagnostics.counts.goal).toBeGreaterThanOrEqual(1);
    expect(diagnostics.syncPending).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});
