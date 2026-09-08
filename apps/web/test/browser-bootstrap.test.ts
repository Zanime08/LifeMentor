import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import {
  LifeMentorApp, type LifeMentorOptions, type LifeMentorApp as LifeMentorAppType,
} from '@lifementor/core';
import { IndexedDbPersistence } from '@lifementor/core/wasm';

/**
 * Browser bootstrap test.
 *
 * Runs the exact code path the web preview uses — `LifeMentorApp.create` with the WASM SQLite
 * driver and the DB image persisted to IndexedDB — under Node, with a real IndexedDB
 * implementation (fake-indexeddb). This is the highest-risk surface: if migrations, the flush
 * after every COMMIT, startup recovery or the offline fallback misbehave here, the user sees a
 * broken or data-losing app in the browser (req. 8/9/94).
 *
 * The "server" is pointed at a closed port on purpose: the browser must remain fully usable
 * offline (local-first), with the AI degrading to the offline engine and sync reporting an
 * honest offline state — never a crash.
 */

// Minimal browser globals so detectPlatform()/detectDriverKind() pick the web path, exactly
// like a real tab does.
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).document = { title: 'LifeMentor' };

const wasmFile = realpathSync(new URL('../../../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url).pathname);
const DEAD_SERVER = 'http://127.0.0.1:9'; // closed port — guaranteed unreachable
const DEVICE_ID = 'device-web-bootstrap-test';

function appOptions(persistence: IndexedDbPersistence): LifeMentorOptions {
  // Mirrors apps/web/src/core/app.ts bootstrapApp(), except the server URL.
  return {
    deviceId: DEVICE_ID,
    driverOptions: { kind: 'wasm', persistence, wasmUrl: wasmFile },
    ai: { providers: [{ kind: 'gateway', gateway: { serverUrl: DEAD_SERVER } }], embeddings: 'local' },
    sync: { serverUrl: DEAD_SERVER, autoStart: true, intervalMs: 3_600_000 },
    auth: { serverUrl: DEAD_SERVER },
    backup: { onFirstLaunch: true },
  };
}

const open: LifeMentorAppType[] = [];
function track(app: LifeMentorAppType): LifeMentorAppType { open.push(app); return app; }
const session1: { goalId: string; taskId: string } = { goalId: '', taskId: '' };
afterAll(async () => {
  for (const app of open) { try { await app.close(); } catch { /* already closed */ } }
});

describe('browser bootstrap (WASM driver + IndexedDB, offline server)', () => {
  it('first launch: migrates, bootstraps, first-launch backup, usable AI and sync offline', async () => {
    const persistence = new IndexedDbPersistence('lifementor-webtest', 'sqlite', 'main');
    const app = track(await LifeMentorApp.create(appOptions(persistence)));

    // Platform/driver selected exactly like in the browser.
    const health = await app.health();
    expect(health.ok).toBe(true);
    expect(health.platform).toBe('web');
    expect(health.driver).toBe('wasm');
    expect(health.integrity.ok).toBe(true);
    expect(health.schemaVersion).toBeGreaterThan(0);

    // The device is registered on first launch.
    expect(await app.repos.devices.count({})).toBe(1);

    // User data written in the first session.
    const goal = await app.services.goals.create({ title: 'Годовой план Web', area: 'career' });
    const task = await app.services.tasks.create({ title: 'Первая задача', goal_id: goal.id, estimated_minutes: 20 });
    expect(task.goal_id).toBe(goal.id);
    session1.goalId = goal.id;
    session1.taskId = task.id;
    const memory = await app.services.memory.save({ kind: 'fact', content: 'Живу в Москве', importance: 0.8 });
    expect(memory.id).toBeTruthy();

    // First-launch baseline backup was created (req. 13) and stored as real bytes.
    const backups = await app.services.backup.list();
    expect(backups).toHaveLength(1);
    expect(backups[0].note).toMatch(/first launch/i);

    // AI: the gateway is unreachable → honest offline degradation, not a crash.
    const turn = await app.ai.mentor.chat('Привет, что ты умеешь?');
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(turn.offline).toBe(true);
    expect(turn.degraded).toBe(true);

    // Sync: reports an offline/honest state, never throws.
    const report = await app.services.sync!.syncOnce();
    expect(report.offline || report.errors.length > 0).toBe(true);
    const syncStatus = await app.services.sync!.status();
    expect(syncStatus.enabled).toBe(true);
    expect(syncStatus.serverUrl).toBe(DEAD_SERVER);

    // Close the "tab".
    await app.close();
    open.splice(open.indexOf(app), 1);

    // The image must have been flushed to IndexedDB (durable) before close.
    const saved = await persistence.load();
    expect(saved).not.toBeNull();
    expect(saved!.byteLength).toBeGreaterThan(10_000);
  });

  it('second launch (new tab): data survives, no duplicate device, no second baseline backup', async () => {
    const persistence = new IndexedDbPersistence('lifementor-webtest', 'sqlite', 'main');
    const app = track(await LifeMentorApp.create(appOptions(persistence)));

    // The startup recovery report (req. 13) comes back clean.
    expect(app.recoveryReport).not.toBeNull();
    expect(app.recoveryReport!.ok).toBe(true);

    // Everything written in the first session is still here.
    const goal = await app.services.goals.get(session1.goalId);
    expect(goal?.title).toBe('Годовой план Web');
    const task = await app.services.tasks.get(session1.taskId);
    expect(task?.title).toBe('Первая задача');
    expect(task?.goal_id).toBe(session1.goalId);
    const memories = await app.services.memory.list();
    expect(memories.some((m) => m.content === 'Живу в Москве')).toBe(true);

    // Same device id → the row is updated, not duplicated.
    const health = await app.health();
    expect(health.deviceId).toBe(DEVICE_ID);
    expect(await app.repos.devices.count({})).toBe(1);
    expect(health.ok).toBe(true);

    // No second first-launch backup.
    const backups = await app.services.backup.list();
    expect(backups).toHaveLength(1);
  });
});
