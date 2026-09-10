import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateVapidKeys } from '../src/config';

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
const bundle = join(serverRoot, 'dist', 'main.mjs');
const dir = mkdtempSync(join(tmpdir(), 'lifementor-bundle-'));
const port = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

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

beforeAll(async () => {
  // Build exactly the way `npm run build:server` does, then start the bundle as an operator would.
  await run(process.execPath, ['build.mjs'], { cwd: serverRoot });
  mkdirSync(join(dir, 'data'), { recursive: true });
  const vapid = generateVapidKeys();
  child = spawn(process.execPath, [bundle], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: join(dir, 'data', 'server.sqlite'),
      JWT_SECRET: 'bundle-test-secret-0123456789abcdef',
      VAPID_PUBLIC_KEY: vapid.public_key,
      VAPID_PRIVATE_KEY: vapid.private_key,
      VAPID_SUBJECT: 'mailto:test@localhost',
      LOG_LEVEL: 'silent',
    },
    stdio: 'pipe',
  });
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
}, 120_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('production server bundle', () => {
  it('boots from dist/main.mjs and serves a healthy, real API', async () => {
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
  }, 60_000);
});
