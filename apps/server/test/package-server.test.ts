import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase gate for the server archive users download (req. 3, 17, 65, 96).
 *
 * Three properties matter and each one has been wrong at some point:
 *  • the bundle is self-contained — it once kept `fastify`/`zod` external, so a machine without
 *    `node_modules` could not start it at all;
 *  • a machine that was never configured gets a stable identity (`.env` with a JWT secret and a
 *    VAPID pair) written for it, because otherwise every restart logs the user out and kills push;
 *  • the archive carries the files an operator actually needs (launcher, autostart, README).
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'lifementor-package-'));
const outDir = join(dir, 'server');
const workDir = join(dir, 'machine');
const shipped = join(outDir, 'lifementor-server.mjs');
const port = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

let child: ChildProcess | null = null;
let output = '';

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, args, { cwd, stdio: 'pipe' });
    let text = '';
    proc.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolvePromise(text) : reject(new Error(`${command} exited with ${code}\n${text}`)));
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
  await run(process.execPath, ['build.mjs'], serverRoot);
  mkdirSync(workDir, { recursive: true });
  await run(process.execPath, [join(repoRoot, 'scripts', 'package-server.mjs'), '--out', outDir], repoRoot);
}, 120_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('packaged server archive', () => {
  it('contains the bundle and the files an operator needs', () => {
    for (const file of ['lifementor-server.mjs', 'README.txt', 'server.bat', 'install-autostart.ps1']) {
      expect(existsSync(join(outDir, file)), `${file} is missing from the archive`).toBe(true);
    }
    const bat = readFileSync(join(outDir, 'server.bat'), 'utf8');
    expect(bat).toMatch(/node lifementor-server\.mjs/);
    // The archive must not depend on the repository: no npm, no workspace paths.
    expect(bat).not.toMatch(/npm |apps\\server/);
    expect(readFileSync(join(outDir, 'install-autostart.ps1'), 'utf8')).toMatch(/lifementor-server\.mjs/);
    expect(readFileSync(join(outDir, 'README.txt'), 'utf8')).toMatch(/v1\/health/);
  });

  it('starts on a machine with no node_modules and configures itself', async () => {
    // Copy the bundle *out* of the archive (as a user would extract it) and run it in an empty
    // directory: no repository, no dependencies, no .env.
    copyFileSync(shipped, join(workDir, 'lifementor-server.mjs'));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PORT: String(port), LOG_LEVEL: 'silent' };
    for (const key of ['JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DATABASE_PATH']) delete env[key];
    child = spawn(process.execPath, [join(workDir, 'lifementor-server.mjs')], { cwd: workDir, env, stdio: 'pipe' });
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    const health = await waitForHealth();
    expect(health.ok).toBe(true);
    expect(health.env).toBe('production');

    const envFile = join(workDir, '.env');
    expect(existsSync(envFile), `.env was not written\n${output}`).toBe(true);
    const text = readFileSync(envFile, 'utf8');
    expect(text).toMatch(/JWT_SECRET=[0-9a-f]{32,}/);
    expect(text).toMatch(/VAPID_PUBLIC_KEY=\S+/);
    expect(text).toMatch(/VAPID_PRIVATE_KEY=\S+/);

    // A real request through the API, not just a health probe.
    const registered = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `package-${Date.now()}@example.com`,
        password: 'Str0ngPass!23',
        display_name: 'Archive Smoke',
        device_id: 'archive-smoke',
      }),
    });
    expect(registered.status).toBeLessThan(400);
  }, 90_000);
});
