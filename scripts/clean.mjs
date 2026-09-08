#!/usr/bin/env node
/**
 * `npm run clean` — remove build output and local caches.
 *
 * Deliberately does NOT touch `data/`, `backups/` or `exports/`: those hold user data, and a
 * cleanup command must never be able to destroy it (req. 12).
 */
import { rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const targets = [
  'packages/core/dist',
  'packages/core/tsconfig.build.tsbuildinfo',
  'apps/server/dist',
  'apps/web/dist',
  'node_modules/.vite',
];

let removed = 0;
for (const target of targets) {
  const path = join(root, target);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  removed += 1;
  process.stdout.write(`removed ${target}\n`);
}

// Tauri / Capacitor build output, when those shells have been built on a release machine.
for (const shell of ['apps/desktop/src-tauri/target', 'apps/mobile/android/app/build', 'apps/mobile/dist']) {
  const path = join(root, shell);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    removed += 1;
    process.stdout.write(`removed ${shell}\n`);
  }
}

if (!removed) process.stdout.write('nothing to clean\n');

const protectedDirs = ['data', 'backups', 'exports', 'logs'];
for (const dir of protectedDirs) {
  const path = join(root, dir);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const entries = readdirSync(path).length;
    process.stdout.write(`kept ${dir}/ (${entries} item(s) — user data is never deleted by clean)\n`);
  }
}
