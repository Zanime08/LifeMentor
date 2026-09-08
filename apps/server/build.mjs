import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Production bundle: `npm run build --workspace @lifementor/server` → `dist/main.mjs`.
 *
 * `@lifementor/core` is compiled *into* the bundle (its package entry point is TypeScript source,
 * which Node cannot run directly), while third-party packages stay external and ship as
 * `node_modules` — that keeps Fastify's plugin loading and any optional native dependency intact.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, '../..');

const external = [
  'fastify', '@fastify/cors', '@fastify/jwt', '@fastify/rate-limit', '@fastify/static', 'zod',
];

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  alias: {
    '@lifementor/core': path.join(monorepoRoot, 'packages/core/src/index.ts'),
  },
  banner: { js: '#!/usr/bin/env node\n// LifeMentor server — bundled entry point (dist/main.mjs)' },
  logLevel: 'info',
});
