import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The public barrel is what every app (desktop, mobile, web, server) imports, so it has to
 * resolve through the workspace alias and expose the whole surface — not just type-check.
 */
import {
  APP_VERSION, AuthService, BackupService, CRITICAL_ENTITY_TYPES, Database, EXPORT_FORMAT_VERSION,
  EntityRepo, LifeMentorApp, MemoryBackupStorage, NodeBackupStorage, PlannerService, RecoveryService,
  SyncEngine, createRepos, dayKey, newId, nowIso,
} from '@lifementor/core';
import type { AuthState, ExportArchive, PushOperation, RecoveryReport, SyncReport, Task } from '@lifementor/core';

let dir: string;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lifementor-barrel-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('@lifementor/core public API', () => {
  it('exposes every layer through the barrel', () => {
    expect(typeof LifeMentorApp.create).toBe('function');
    expect(typeof Database.open).toBe('function');
    expect(typeof createRepos).toBe('function');
    expect(EntityRepo).toBeTruthy();
    for (const service of [SyncEngine, BackupService, RecoveryService, AuthService, PlannerService]) {
      expect(typeof service).toBe('function');
    }
    expect(NodeBackupStorage).toBeTruthy();
    expect(MemoryBackupStorage).toBeTruthy();
    expect(CRITICAL_ENTITY_TYPES.has('goal')).toBe(true);
    expect(EXPORT_FORMAT_VERSION).toBe(1);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(newId('task')).toMatch(/^task_/);
    expect(nowIso()).toMatch(/T.*Z$/);
    expect(dayKey(new Date('2026-03-04T05:06:07Z'))).toBe('2026-03-04');
  });

  it('runs a whole session through the barrel exports', async () => {
    const app = await LifeMentorApp.create({
      driverOptions: { kind: 'node', path: join(dir, 'barrel.sqlite'), durability: 'paranoid' },
      deviceId: 'device-barrel',
      backup: { storage: new MemoryBackupStorage(), onFirstLaunch: false },
    });

    // the app opened, migrated and ran startup recovery
    const report: RecoveryReport | null = app.recoveryReport;
    expect(report?.ok).toBe(true);

    const goal = await app.services.goals.create({ title: 'Barrel smoke test', horizon: 'short' });
    const task: Task = await app.services.tasks.create({ title: 'Imported through the alias', estimated_minutes: 15, goal_id: goal.id });
    expect(task.sync_state).toBe('pending');

    // persistence layers reachable from the barrel
    const backup = await app.services.backup.createBackup('manual');
    expect(backup.status).toBe('ok');
    const archive: ExportArchive = await app.services.backup.exportArchive();
    expect(archive.manifest.counts.task).toBeGreaterThanOrEqual(1);

    const authState: AuthState = await app.services.auth.state();
    expect(authState.offlineOnly).toBe(true);

    // sync is opt-in: without a server there is no engine, and the app says so
    expect(app.services.sync).toBeNull();

    // enabling it at runtime wires the engine, the queue and the settings together
    const seen: PushOperation[] = [];
    const engine = app.configureSync({
      serverUrl: 'https://sync.lifementor.test',
      transport: {
        push: async (operations) => {
          seen.push(...operations);
          return operations.map((op) => ({ operation_id: op.operation_id, status: 'applied' as const, server_version: op.version }));
        },
        pull: async () => ({ changes: [], cursor: '0' }),
      },
    });
    expect(app.services.sync).toBe(engine);
    expect((await app.services.settings.all()).sync.enabled).toBe(true);

    // enabling sync kicks off a cycle right away, so wait for the queue to drain
    await vi.waitFor(async () => {
      expect((await engine.status()).pending).toBe(0);
    }, { timeout: 3000, interval: 25 });

    // the queued writes reached the transport: goal, task and the settings they touched
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.some((op) => op.entity_type === 'goal' && op.entity_id === goal.id)).toBe(true);
    expect(seen.some((op) => op.entity_type === 'task' && op.entity_id === task.id)).toBe(true);
    expect((await app.services.tasks.get(task.id))?.sync_state).toBe('synchronized');

    // a second explicit cycle is a clean no-op
    const syncReport: SyncReport = await engine.syncOnce();
    expect(syncReport.offline).toBe(false);
    expect(syncReport.errors).toEqual([]);
    expect(syncReport.pushed).toBe(0);
    engine.stop();

    await app.close();
  });
});
