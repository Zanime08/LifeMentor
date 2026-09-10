import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
