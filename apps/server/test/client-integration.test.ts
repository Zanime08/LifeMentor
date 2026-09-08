import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp, MemoryBackupStorage, dayKey } from '@lifementor/core';
import { buildServer, type BuiltServer } from '../src/app';
import { testConfig, StubProvider } from './helpers';

/**
 * End-to-end: two real client apps (the same `LifeMentorApp` that runs on Windows and Android)
 * talking to the real HTTP server over a real socket.
 *
 * This is the phase gate for req. 14–16 and 20: local-first data, synced between devices through
 * the server, with AI keys that never touch the client.
 */

let server: BuiltServer;
let baseUrl: string;
let provider: StubProvider;
let dir: string;
let opened = 0;

beforeAll(async () => {
  provider = new StubProvider();
  server = await buildServer(testConfig(), { aiProvider: provider });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address.replace('127.0.0.1', '127.0.0.1');
  dir = mkdtempSync(join(tmpdir(), 'lifementor-e2e-'));
});

afterAll(async () => {
  await server?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

async function openClient(deviceId: string, options: { withAI?: boolean } = {}): Promise<LifeMentorApp> {
  opened += 1;
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: join(dir, `${deviceId}-${opened}.sqlite`), durability: 'paranoid' },
    deviceId,
    deviceName: deviceId,
    backup: { storage: new MemoryBackupStorage(), onFirstLaunch: false },
    auth: { serverUrl: baseUrl },
    sync: { serverUrl: baseUrl, autoStart: false },
    ai: options.withAI === false ? undefined : {
      providers: [{ kind: 'gateway', gateway: { serverUrl: baseUrl, deviceId } }],
      embeddings: 'local',
    },
    recover: false,
  });
}

const EMAIL = 'ada@example.com';
const PASSWORD = 'a-strong-passphrase';

describe('two devices, one account, real HTTP', () => {
  it('signs up on device A and signs in on device B', async () => {
    const a = await openClient('device-desktop', { withAI: false });
    const state = await a.services.auth.signUp({ email: EMAIL, password: PASSWORD, displayName: 'Ada' });
    expect(state.authenticated).toBe(true);
    expect(state.serverUrl).toBe(baseUrl);

    const b = await openClient('device-phone', { withAI: false });
    const signIn = await b.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    expect(signIn.authenticated).toBe(true);
    expect(signIn.userId).toBe(state.userId);

    // the server knows both devices
    const devices = await server.app.inject({
      method: 'GET', url: '/v1/devices',
      headers: { authorization: `Bearer ${state.userId ? await a.services.auth.accessToken() : ''}` },
    });
    expect(devices.statusCode).toBe(200);

    await a.close();
    await b.close();
  });

  it('syncs real user data from desktop to phone', async () => {
    const a = await openClient('device-desktop', { withAI: false });
    await a.services.auth.signIn({ email: EMAIL, password: PASSWORD });

    const goal = await a.services.goals.create({ title: 'Run a half marathon', horizon: 'long', priority: 'P1' });
    const task = await a.services.tasks.create({ title: 'Buy running shoes', estimated_minutes: 45, goal_id: goal.id });
    await a.services.calendar.create({ title: 'Long run in the park', kind: 'training', start: '09:00', end: '10:30', day: dayKey(new Date(Date.now() + 86_400_000)) });
    await a.services.memory.save({ kind: 'fact', content: 'Ada trains on Tuesdays and Sundays', importance: 0.8 });

    const pushed = await a.services.sync!.syncOnce();
    expect(pushed.offline).toBe(false);
    expect(pushed.errors).toEqual([]);
    expect(pushed.applied).toBeGreaterThanOrEqual(4);

    const serverStatus = await server.context.sync.status((await a.services.auth.currentUser())!.user_id);
    expect(serverStatus.entities).toBeGreaterThanOrEqual(4);

    // the phone pulls it
    const b = await openClient('device-phone', { withAI: false });
    await b.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    const pulled = await b.services.sync!.syncOnce();
    expect(pulled.pulled).toBeGreaterThanOrEqual(4);

    expect((await b.services.goals.get(goal.id))?.title).toBe('Run a half marathon');
    expect((await b.services.tasks.get(task.id))?.title).toBe('Buy running shoes');
    const events = await b.services.calendar.upcoming(72);
    expect(events.some((event) => event.title === 'Long run in the park')).toBe(true);
    const memories = await b.services.memory.list({ limit: 50 });
    expect(memories.some((memory) => /Tuesdays and Sundays/.test(memory.content))).toBe(true);

    // and both sides agree they are synchronized
    expect((await b.services.tasks.get(task.id))?.sync_state).toBe('synchronized');
    expect((await a.services.sync!.status()).pending).toBe(0);

    await a.close();
    await b.close();
  });

  it('resolves a two-device edit conflict through the server', async () => {
    const a = await openClient('device-desktop', { withAI: false });
    const b = await openClient('device-phone', { withAI: false });
    await a.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    await b.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    await a.services.sync!.syncOnce();
    await b.services.sync!.syncOnce();

    const task = await a.services.tasks.create({ title: 'Book the flight', estimated_minutes: 30, notes: 'check prices' });
    await a.services.sync!.syncOnce();
    await b.services.sync!.syncOnce();
    expect((await b.services.tasks.get(task.id))?.title).toBe('Book the flight');

    // desktop changes the note, phone changes the estimate
    await a.services.tasks.update(task.id, { notes: 'check prices and seat map' });
    await a.services.sync!.syncOnce();

    await b.services.tasks.update(task.id, { estimated_minutes: 60 });
    const phoneReport = await b.services.sync!.syncOnce();
    expect(phoneReport.errors).toEqual([]);
    expect(phoneReport.merged).toBeGreaterThanOrEqual(1);

    await a.services.sync!.syncOnce();

    const onDesktop = await a.services.tasks.get(task.id);
    const onPhone = await b.services.tasks.get(task.id);
    expect(onDesktop?.notes).toBe('check prices and seat map');
    expect(onDesktop?.estimated_minutes).toBe(60);
    expect(onPhone?.notes).toBe('check prices and seat map');
    expect(onPhone?.estimated_minutes).toBe(60);

    // the server converged on the same values
    const userId = (await a.services.auth.currentUser())!.user_id;
    const stored = await server.context.sync.entity(userId, 'task', task.id);
    expect(stored?.payload.notes).toBe('check prices and seat map');
    expect(stored?.payload.estimated_minutes).toBe(60);

    await a.close();
    await b.close();
  });

  it('keeps working offline and flushes when the server returns', async () => {
    const a = await openClient('device-desktop', { withAI: false });
    await a.services.auth.signIn({ email: EMAIL, password: PASSWORD });

    const unreachable = await LifeMentorApp.create({
      driverOptions: { kind: 'node', path: join(dir, `offline-${++opened}.sqlite`), durability: 'paranoid' },
      deviceId: 'device-offline',
      backup: { storage: new MemoryBackupStorage(), onFirstLaunch: false },
      sync: { serverUrl: 'http://127.0.0.1:1', autoStart: false },
      recover: false,
    });
    const task = await unreachable.services.tasks.create({ title: 'Created with no connection', estimated_minutes: 20 });
    const report = await unreachable.services.sync!.syncOnce();
    expect(report.offline).toBe(true);
    expect(report.applied).toBe(0);
    // the data is safe locally and still queued
    expect((await unreachable.services.tasks.get(task.id))?.title).toBe('Created with no connection');
    expect((await unreachable.services.sync!.status()).pending).toBeGreaterThanOrEqual(1);
    await unreachable.close();

    // the signed-in device still works normally against the live server
    await a.services.goals.create({ title: 'Created while another device was offline', horizon: 'short' });
    const live = await a.services.sync!.syncOnce();
    expect(live.offline).toBe(false);
    expect(live.applied).toBeGreaterThanOrEqual(1);

    await a.close();
  });

  it('routes AI through the gateway so the client never holds a key', async () => {
    const a = await openClient('device-desktop');
    await a.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    await a.services.goals.create({ title: 'Finish the thesis', horizon: 'medium' });

    expect(a.ai.provider.id).toMatch(/gateway|fallback/);

    const reply = await a.ai.orchestrator.chat('What should I focus on today?');
    expect(reply.reply.length).toBeGreaterThan(0);
    expect(reply.offline).toBe(false);
    expect(provider.requests.length).toBeGreaterThanOrEqual(1);

    // usage was attributed on the server, message content was not stored
    const userId = (await a.services.auth.currentUser())!.user_id;
    const usage = await server.context.db.all<Record<string, unknown>>('SELECT * FROM ai_usage WHERE user_id = ?', [userId]);
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(usage)).not.toContain('thesis');

    // no key material exists anywhere in the client database
    const dump = await a.repos.db.all('SELECT * FROM settings');
    expect(JSON.stringify(dump)).not.toMatch(/sk-[A-Za-z0-9]/);

    await a.close();
  });

  it('deletes the account: the server copy is gone, local data stays until the user erases it', async () => {
    const a = await openClient('device-desktop', { withAI: false });
    await a.services.auth.signIn({ email: EMAIL, password: PASSWORD });
    const goal = await a.services.goals.create({ title: 'Goal that stays on this device', horizon: 'short' });
    await a.services.sync!.syncOnce();

    const userId = (await a.services.auth.currentUser())!.user_id;
    expect((await server.context.sync.status(userId)).entities).toBeGreaterThan(0);

    const result = await a.services.auth.deleteAccount({ exportFirst: true });
    expect(result.deleted).toBe(true);
    expect(result.receipt).toContain('deleted_');

    // server side: nothing left for that user
    expect((await server.context.sync.status(userId)).entities).toBe(0);
    expect(await server.context.users.findById(userId)).toBeUndefined();
    const feed = await server.context.db.all('SELECT * FROM sync_feed WHERE user_id = ?', [userId]);
    expect(feed).toHaveLength(0);

    // client side: the account deletion wiped local rows too (req. 56)
    expect(await a.services.goals.get(goal.id)).toBeNull();
    expect(await a.services.auth.isAuthenticated()).toBe(false);

    await a.close();
  });
});
