import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { initEnv, renderEnv } from '../src/tools/init-env';
import { loadConfig } from '../src/config';

/**
 * Phase gate for the end-user install path (req. 3, 16, 96).
 *
 * Without a `.env`, the server starts with a throwaway JWT secret and a fresh VAPID pair on every
 * launch: the user is logged out and every push subscription dies on restart. `npm run init:env`
 * writes a stable configuration once; these tests pin the two properties that make it usable —
 * it produces a *valid* configuration, and it never overwrites one that already exists.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifementor-init-env-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Parse a generated `.env` the same way an operator would read it. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

describe('init:env', () => {
  it('writes a stable configuration that a production server accepts', () => {
    const dir = tempDir();
    const result = initEnv(dir);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, '.env'));

    const values = parse(readFileSync(result.path, 'utf8'));
    expect(values.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(values.VAPID_PUBLIC_KEY.length).toBeGreaterThan(20);
    expect(values.VAPID_PRIVATE_KEY.length).toBeGreaterThan(20);

    // The point of the file: the server starts in production mode with it, i.e. with real
    // sessions and push that survive a restart.
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_PATH: join(dir, 'server.sqlite'),
      ...values,
    } as unknown as NodeJS.ProcessEnv);
    expect(config.jwtSecret).toBe(values.JWT_SECRET);
    expect(config.push.vapidPublicKey).toBe(values.VAPID_PUBLIC_KEY);
    expect(config.push.vapidPrivateKey).toBe(values.VAPID_PRIVATE_KEY);
    expect(config.push.vapidPublicGenerated).toBe(false);
  });

  it('never overwrites an existing file (safe to run twice)', () => {
    const dir = tempDir();
    const first = initEnv(dir);
    const before = readFileSync(first.path, 'utf8');

    const second = initEnv(dir);
    expect(second.created).toBe(false);
    expect(second.keys.length).toBeGreaterThan(0);
    expect(readFileSync(second.path, 'utf8')).toBe(before);
  });

  it('does not invent provider keys and keeps the file readable', () => {
    const text = renderEnv({ JWT_SECRET: 'x'.repeat(40), DATABASE_PATH: 'data/server.sqlite' });
    expect(text).toMatch(/^# LifeMentor server/m);
    expect(text).toContain('DATABASE_PATH=data/server.sqlite');
    expect(text).not.toMatch(/OPENAI_API_KEY=/);
    expect(text.endsWith('\n')).toBe(true);
  });
});
