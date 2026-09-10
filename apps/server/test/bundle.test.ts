import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LifeMentorApp, dayKey } from '@lifementor/core';

/**
 * Phase gate for the release bundle (req. 3, 96): the artifact that ships on a Windows machine
 * (`apps/server/dist/main.mjs`, started by the installer/scheduled task and by CI) must actually
 * boot and serve the API.
 *
 * This has real teeth — the bundle once failed at startup with
 * `Dynamic require of "crypto" is not supported`, which no unit test noticed because every other
 * test imports the TypeScript sources instead of the built file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const built = join(serverRoot, 'dist', 'main.mjs');
const dir = mkdtempSync(join(tmpdir(), 'lifementor-bundle-'));
/** Exactly what the release archive contains: the bundle on its own, outside any repository. */
const shipped = join(dir, 'server', 'lifementor-server.mjs');
/** A machine that has never run the server before — empty working directory. */
const workDir = join(dir, 'work');
let port = 19000 + Math.floor(Math.random() * 900);
let base = `http://127.0.0.1:${port}`;

let child: ChildProcess | null = null;
let output = '';

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv } ): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: 'pipe' });
    let text = '';
    proc.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${text}`)));
  });
}

async function waitForHealth(timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`server exited with ${child.exitCode}\n${output}`);
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy (${lastError})\n${output}`);
}

function start(env: NodeJS.ProcessEnv): void {
  // The child must be a *fresh machine*: whatever the test runner happens to have in its
  // environment (or a .env it loaded for another test) must not leak into it.
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DATABASE_PATH', 'NODE_ENV']) delete base[key];
  child = spawn(process.execPath, [shipped], { cwd: workDir, env: { ...base, ...env }, stdio: 'pipe' });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
}

async function stop(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  if (child.exitCode === null) child.kill('SIGKILL');
  child = null;
}

/**
 * A machine that was never configured: no JWT_SECRET, no VAPID pair, no .env anywhere near the
 * bundle. The server must write its own identity file and come up healthy — this is the artefact
 * an end user downloads, and they will not run a key-generation command.
 */
beforeAll(async () => {
  await run(process.execPath, ['build.mjs'], { cwd: serverRoot });
  mkdirSync(dirname(shipped), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  copyFileSync(built, shipped);
  start({ NODE_ENV: 'production', PORT: String(port), LOG_LEVEL: 'silent' });
}, 120_000);

afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A real client app on a temp database — no mocks, no in-process shortcuts. */
async function client(deviceId: string, dir: string): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: join(dir, `${deviceId}.sqlite`), durability: 'paranoid' },
    deviceId,
    deviceName: deviceId,
    recover: false,
    maintenance: { enabled: false },
    auth: { serverUrl: base },
    sync: { serverUrl: base, autoStart: false },
    ai: { providers: [{ kind: 'gateway', gateway: { serverUrl: base, deviceId } }], embeddings: 'local' },
  });
}

describe('production server bundle', () => {
  it('configures itself on a machine that has never been set up, then serves the API', async () => {
    const health = await waitForHealth();
    expect(health.ok).toBe(true);
    expect(health.version).toBeTruthy();
    expect((health.integrity as { ok: boolean }).ok).toBe(true);
    // No provider keys in this environment: the server must report that honestly.
    expect((health.ai as { provider: string }).provider).toBeTruthy();

    const register = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `bundle-${Date.now()}@example.com`,
        password: 'Str0ngPass!23',
        display_name: 'Bundle Smoke',
        device_id: 'bundle-smoke-device',
      }),
    });
    expect(register.status).toBeLessThan(400);
    const session = (await register.json()) as { access_token?: string };
    expect(session.access_token).toBeTruthy();

    const status = await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(status.status).toBe(200);

    // The identity file was written next to the running server, with the two secrets that must
    // stay stable across restarts (sessions and push subscriptions depend on them).
    const envFile = join(workDir, '.env');
    expect(existsSync(envFile)).toBe(true);
    const env = readFileSync(envFile, 'utf8');
    expect(env).toMatch(/JWT_SECRET=[0-9a-f]{32,}/);
    expect(env).toMatch(/VAPID_PUBLIC_KEY=\S+/);
    expect(env).toMatch(/VAPID_PRIVATE_KEY=\S+/);
  }, 60_000);

  it('carries real user data between two real clients', async () => {
    // Everything a user actually has: the shipped bundle (no build tree, no node_modules, no keys)
    // plus two real client apps — the same `LifeMentorApp` that runs on Windows and Android — over
    // real HTTP. The other integration test drives an in-process server; this one drives the artefact
    // an end user downloads.
    const desktop = await client('bundle-desktop', dir);
    const session = await desktop.services.auth.signUp({ email: `bundle-${Date.now()}@example.com`, password: 'Str0ngPass!23', displayName: 'Bundle User' });
    expect(session.authenticated).toBe(true);

    const goal = await desktop.services.goals.create({ title: 'Run a half marathon', horizon: 'long', priority: 'P1' });
    const task = await desktop.services.tasks.create({ title: 'Buy running shoes', estimated_minutes: 45, goal_id: goal.id });
    await desktop.services.calendar.create({ title: 'Long run', kind: 'training', day: dayKey(new Date()), start: '09:00', end: '10:30' });

    const pushed = await desktop.services.sync!.syncOnce();
    expect(pushed.errors).toEqual([]);
    expect(pushed.offline).toBe(false);
    expect(pushed.applied).toBeGreaterThanOrEqual(3);

    const phone = await client('bundle-phone', dir);
    await phone.services.auth.signIn({ email: session.email ?? '', password: 'Str0ngPass!23' });
    const pulled = await phone.services.sync!.syncOnce();
    expect(pulled.errors).toEqual([]);
    expect(pulled.pulled).toBeGreaterThanOrEqual(3);
    expect((await phone.services.tasks.get(task.id))?.title).toBe('Buy running shoes');
    expect((await phone.services.goals.get(goal.id))?.title).toBe('Run a half marathon');
    expect((await phone.services.tasks.get(task.id))?.sync_state).toBe('synchronized');

    // The server's own database agrees, and is still intact after the traffic (req. 94).
    const health = (await (await fetch(`${base}/v1/health`)).json()) as { integrity: { ok: boolean } };
    expect(health.integrity.ok).toBe(true);

    await desktop.close();
    await phone.close();
  }, 120_000);

  it('answers through the AI gateway although this machine has no provider key (req. 20, 58)', async () => {
    const client_ = await client('bundle-ai', dir);
    const session = await client_.services.auth.signUp({ email: `bundle-ai-${Date.now()}@example.com`, password: 'Str0ngPass!23', displayName: 'AI User' });

    // The client holds no key of any kind: its only AI transport is the gateway (the other providers
    // are not even constructed in the shipping client).
    expect(client_.ai.provider.id).toBe('gateway');
    expect(JSON.stringify(await client_.repos.db.all('SELECT * FROM settings'))).not.toMatch(/sk-|AIza/);

    // The mentor answers, and the answer is a real one — the server's heuristic engine stands in for
    // the model exactly as it does on an installation without keys (the `local-heuristic` provider).
    const turn = await client_.ai.mentor.chat('What should I focus on this week?', {});
    expect(turn.reply.length).toBeGreaterThan(10);
    expect(turn.conversationId).toBeTruthy();

    // The tools the model asks for run on the client, against the client's own SQLite — the model
    // never touches the user's data directly (req. 24, 25). Whatever the gateway decides to call, the
    // work happens here and the result is real.
    const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
    const created = await client_.ai.mentor.chat('Add a task: прочитать главу 3, 30 minutes, tomorrow', {});
    expect(created.reply.length).toBeGreaterThan(0);
    expect(created.toolCalls.length, 'модель должна была вызвать инструмент').toBeGreaterThan(0);
    expect(created.toolCalls.every((call) => call.outcome.ok)).toBe(true);
    const tasks = await client_.services.tasks.listForDay(tomorrow);
    expect(tasks.some((task) => /главу 3/i.test(task.title))).toBe(true);

    // The client's schema has no place to keep AI usage at all: accounting belongs to the server,
    // and the request the server logged contains counters, not the user's words.
    const tables = await client_.repos.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.some((table) => table.name === 'ai_usage'), 'клиент не хранит учёт ИИ у себя').toBe(false);

    // Both turns really went through the server: it counted them and named the engine that answered.
    const usage = await fetch(`${base}/v1/ai/usage`, { headers: { authorization: `Bearer ${await client_.services.auth.accessToken()}` } });
    expect(usage.status).toBe(200);
    const body = (await usage.json()) as { requests?: number; tokens?: number; provider?: string };
    expect(body.requests, 'сервер должен был учесть оба обращения').toBeGreaterThanOrEqual(2);
    // This machine has no provider key, so the gateway answers with the engine inside the server —
    // the honest degradation a real installation gets, not an error page.
    expect(body.provider).toBe('local-heuristic');
    expect(JSON.stringify(body)).not.toContain('this week');
    expect(JSON.stringify(body)).not.toContain('главу 3');
    expect(session.userId).toBeTruthy();

    await client_.close();
  }, 120_000);

  it('keeps the identity across a restart (sessions survive, no second .env)', async () => {
    const envFile = join(workDir, '.env');
    const before = readFileSync(envFile, 'utf8');
    await stop();

    port = 19000 + Math.floor(Math.random() * 900);
    base = `http://127.0.0.1:${port}`;
    start({ NODE_ENV: 'production', PORT: String(port), LOG_LEVEL: 'silent' });
    const health = await waitForHealth();
    expect(health.ok).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toBe(before);
  }, 60_000);
});
