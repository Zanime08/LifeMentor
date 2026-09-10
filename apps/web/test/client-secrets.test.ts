import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the rule that provider keys never reach a client (req. 20, 58, 95).
 *
 * The Windows, Android and web clients are all built from `apps/web/dist`, so one scan covers all
 * three. Two things are checked here:
 *  • the scanner still detects credentials (a check that quietly stops matching is worse than none);
 *  • the client bundle that exists on this machine is clean — skipped when it has not been built,
 *    because CI runs the real scan in its own job right after the build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'check-client-secrets.mjs');

function run(args: string[]): { code: number; output: string } {
  try {
    // A clean environment: vitest injects module loaders through NODE_OPTIONS, which the child
    // process must not inherit (it would try to resolve them again outside the runner).
    const output = execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' },
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('client bundle credential guard', () => {
  it('detects seeded credentials, including in files without a known extension', () => {
    const result = run(['--self-test']);
    expect(result.output).toMatch(/self-test ok/);
    expect(result.code).toBe(0);
  });

  it('finds no credentials in the built client bundle', () => {
    const dist = join(repoRoot, 'apps', 'web', 'dist');
    if (!existsSync(dist)) {
      expect(existsSync(dist)).toBe(false); // not built here — CI scans it in the client-bundle job
      return;
    }
    const result = run([dist]);
    expect(result.output).toContain('No credentials');
    expect(result.code).toBe(0);
  });
});
