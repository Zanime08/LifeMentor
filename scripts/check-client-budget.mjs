#!/usr/bin/env node
/**
 * Client startup budget (phase-20 performance gate, req. 96).
 *
 * The packaged Windows/Android client must parse and compile whatever it downloads before the first
 * screen appears. That used to be a single 820 kB script containing all sixteen screens — the user
 * paid for the Settings form (800 lines) before seeing the dashboard. The screens are now separate
 * chunks, and this script makes that a **checked property of the build** rather than a claim in a
 * document: a future `import { Settings } from './screens/Settings'` at the top of `App.tsx` would
 * quietly put everything back into the entry chunk, and this check turns red.
 *
 *   node scripts/check-client-budget.mjs [--dist apps/web/dist] [--self-test]
 *
 * It reads the built output only (the CI job builds immediately before running it), so it stays
 * fast and cannot be fooled by a stale build of a different configuration.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const distIndex = args.indexOf('--dist');
const dist = resolve(distIndex >= 0 ? args[distIndex + 1] : join(root, 'apps', 'web', 'dist'));
const selfTest = args.includes('--self-test');

/** Kilobytes, gzip — what a client actually downloads and decompresses. */
const BUDGET = {
  /** The entry script + vendor: everything needed before the first screen renders. */
  initial: 210,
  /** A coarse ceiling on the single biggest file in the build. */
  largest: 200,
};

/**
 * Phrases that live in exactly one screen each. Finding one of them in the startup download means
 * that screen was pulled back into the entry chunk — a byte budget alone is too blunt to notice a
 * 4 kB screen riding along, but the string cannot be there by accident.
 */
const SCREEN_MARKERS = [
  { screen: 'Settings', text: 'Аккаунт и синхронизация' },
  { screen: 'Today', text: 'Остаток дня пересобран' },
  { screen: 'Knowledge', text: 'Строю карту знаний' },
  { screen: 'Progress', text: 'Снепшот дня' },
  { screen: 'Projects', text: 'Требуют внимания' },
  { screen: 'Strategy', text: 'Закрыть направление' },
];

/**
 * What the entry point pulls in *before* any screen route is opened: the module `<script>` tags of
 * `index.html`. Route chunks are fetched on demand and are deliberately not counted here — that is
 * the whole point of the split.
 */
function initialScripts(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const modulePreloads = [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set([...srcs, ...modulePreloads])].map((src) => src.replace(/^\.?\//, ''));
}

function kb(bytes) {
  return bytes / 1024;
}

function measure(distDir) {
  const files = initialScripts(distDir);
  const rows = files.map((file) => {
    const bytes = readFileSync(join(distDir, file));
    return { file, raw: kb(bytes.length), gzip: kb(gzipSync(bytes).length) };
  });
  const all = readdirSync(join(distDir, 'assets')).filter((f) => f.endsWith('.js'));
  const largest = all
    .map((f) => ({ file: f, gzip: kb(gzipSync(readFileSync(join(distDir, 'assets', f))).length) }))
    .sort((a, b) => b.gzip - a.gzip)[0];
  const initialGzip = rows.reduce((sum, r) => sum + r.gzip, 0);
  // Which screen markers ended up in the startup download, and which are still in the build at all
  // (a marker that no longer exists anywhere would make the rule pass by being vacuous).
  const initialText = rows.map((r) => readFileSync(join(distDir, r.file), 'utf8')).join('\n');
  const everyChunk = all.map((f) => readFileSync(join(distDir, 'assets', f), 'utf8')).join('\n');
  const leaked = SCREEN_MARKERS.filter((m) => initialText.includes(m.text)).map((m) => m.screen);
  const vanishing = SCREEN_MARKERS.filter((m) => !everyChunk.includes(m.text)).map((m) => m.screen);
  return { rows, initialGzip, largest, chunks: all.length, leaked, vanishing };
}

if (selfTest) {
  // The check must be able to fail: a bundle with everything in one file is exactly what it exists
  // to catch, so build that case in memory and assert the verdict is negative.
  const blended = {
    initialGzip: BUDGET.initial + 10, largest: { file: 'index.js', gzip: BUDGET.largest + 10 }, chunks: 1,
    leaked: ['Settings', 'Today'], vanishing: [],
  };
  const verdict = violations(blended);
  if (verdict.length !== 3) {
    console.error(`--self-test failed: expected 3 violations, got ${JSON.stringify(verdict)}`);
    process.exit(1);
  }
  if (violations({ initialGzip: 10, largest: { file: 'a.js', gzip: 10 }, chunks: 30, leaked: [], vanishing: ['Progress'] }).length !== 1) {
    console.error('--self-test failed: a marker that vanished from the build must be reported');
    process.exit(1);
  }
  console.log('self-test ok');
  process.exit(0);
}

function violations(m) {
  const out = [];
  if (m.initialGzip > BUDGET.initial) {
    out.push(`the startup download is ${m.initialGzip.toFixed(1)} kB gzip, budget ${BUDGET.initial} kB — the entry chunk is pulling screens back in`);
  }
  if (m.largest.gzip > BUDGET.largest) {
    out.push(`the largest script is ${m.largest.file} at ${m.largest.gzip.toFixed(1)} kB gzip, budget ${BUDGET.largest} kB`);
  }
  if (m.leaked?.length) {
    out.push(`these screens are part of the startup download: ${m.leaked.join(', ')} — import them with \`lazy()\` in App.tsx`);
  }
  if (m.vanishing?.length) {
    out.push(`these screens are no longer in the build at all, so the check above proves nothing: ${m.vanishing.join(', ')}`);
  }
  return out;
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`no build at ${dist} — run \`npm run build --workspace @lifementor/web\` first`);
  process.exit(1);
}

const m = measure(dist);
console.log(`Startup download (${m.rows.length} files, ${m.chunks} scripts in the build):`);
for (const r of m.rows) console.log(`  ${r.file.padEnd(40)} ${r.raw.toFixed(1).padStart(7)} kB raw · ${r.gzip.toFixed(1).padStart(6)} kB gzip`);
console.log(`  ${'total'.padEnd(40)} ${''.padStart(7)}        ${m.initialGzip.toFixed(1).padStart(6)} kB gzip`);
console.log(`Largest script: ${m.largest.file} — ${m.largest.gzip.toFixed(1)} kB gzip`);

const bad = violations(m);
if (bad.length) {
  for (const message of bad) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(`✓ within budget (startup ≤ ${BUDGET.initial} kB gzip, per-script ≤ ${BUDGET.largest} kB gzip)`);
