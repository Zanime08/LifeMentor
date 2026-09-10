import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/dotenv';
import { loadConfig } from '../src/config';
import { SERVER_ROOT } from '../src/paths';

const dirs: string[] = [];

function withEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifementor-dotenv-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), content, 'utf8');
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('loadDotEnv', () => {
  it('returns 0 when there is no .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifementor-dotenv-'));
    dirs.push(dir);
    expect(loadDotEnv(dir)).toBe(0);
  });

  it('parses KEY=VALUE, comments and blank lines', () => {
    const dir = withEnvFile('# comment\n\nPORT=9999\n  # indented comment\nHOST=127.0.0.1\n');
    delete process.env.PORT;
    delete process.env.HOST;
    expect(loadDotEnv(dir)).toBe(2);
    expect(process.env.PORT).toBe('9999');
    expect(process.env.HOST).toBe('127.0.0.1');
  });

  it('strips optional quotes, including values with spaces', () => {
    const dir = withEnvFile('A="quoted value"\nB=\'single quoted\'\nC=plain\n');
    delete process.env.A;
    delete process.env.B;
    delete process.env.C;
    loadDotEnv(dir);
    expect(process.env.A).toBe('quoted value');
    expect(process.env.B).toBe('single quoted');
    expect(process.env.C).toBe('plain');
  });

  it('never overrides values already present in the environment', () => {
    const dir = withEnvFile('PORT=1111\n');
    process.env.PORT = '8787';
    loadDotEnv(dir);
    expect(process.env.PORT).toBe('8787');
  });
});

describe('config default database path', () => {
  it('is anchored to the repository root, not to the process cwd', () => {
    const saved = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;
    try {
      const cfg = loadConfig({ ...process.env, NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(24) });
      expect(cfg.databasePath).toBe(join(SERVER_ROOT, 'data', 'server.sqlite'));
    } finally {
      if (saved !== undefined) process.env.DATABASE_PATH = saved;
    }
  });
});
