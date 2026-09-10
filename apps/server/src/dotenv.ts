import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_ROOT } from './paths';

/**
 * Minimal dependency-free `.env` loader (KEY=VALUE lines, `#` comments,
 * optional single/double quotes). Values already present in `process.env`
 * always win, so the OS/shell environment keeps priority over the file.
 *
 * `.env` is an operator-side convenience for a local machine (JWT_SECRET,
 * provider keys, VAPID keys, …); it is gitignored and never leaves the machine.
 *
 * Lookup: when called without an explicit directory, both the process cwd and
 * the repository root are tried (first hit wins) — npm runs workspace scripts
 * with cwd = `apps/server`, while operators conventionally keep `.env` in the
 * repo root next to `.env.example`.
 *
 * @param cwd explicit directory to read `.env` from (tests); omit to use
 *           [process.cwd(), repository root].
 * @returns the number of variables actually applied (0 when no `.env` found).
 */
export function loadDotEnv(cwd?: string): number {
  const dirs = cwd !== undefined ? [cwd] : [process.cwd(), SERVER_ROOT];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const d = resolve(dir);
    if (seen.has(d)) continue;
    seen.add(d);
    let text: string;
    try {
      text = readFileSync(resolve(d, '.env'), 'utf8');
    } catch {
      continue;
    }
    return parseDotEnvText(text);
  }
  return 0;
}

/**
 * Is there a `.env` anywhere the loader would look (cwd, then the repository root)?
 *
 * Used by the self-initialising server: a machine that has never been configured gets one written
 * for it, while an operator's existing file — in either location — is never touched.
 */
export function hasEnvFile(cwd?: string): boolean {
  const dirs = cwd !== undefined ? [cwd] : [process.cwd(), SERVER_ROOT];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const d = resolve(dir);
    if (seen.has(d)) continue;
    seen.add(d);
    if (existsSync(resolve(d, '.env'))) return true;
  }
  return false;
}

function parseDotEnvText(text: string): number {
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
