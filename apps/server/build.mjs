import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Production bundle: `npm run build --workspace @lifementor/server` → `dist/main.mjs`.
 *
 * Everything goes into the bundle — the engine (`@lifementor/core`) and every dependency, Fastify
 * and zod included. The result is the single file a user extracts from `release/server` and starts
 * with `node lifementor-server.mjs`: no `node_modules`, no `npm install`, nothing to configure
 * (the server writes its own `.env` on first start, see `src/tools/init-env.ts`).
 *
 * `npm run package:server` turns the bundle into that user-facing archive.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, '../..');

const external = []; // deliberately empty: the archive must run on a machine with no dependencies

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
  // The bundle is ESM, but some bundled CommonJS dependencies still call `require('node:crypto')`.
  // Without a `require` in scope esbuild's shim throws `Dynamic require of "crypto" is not
  // supported` at startup. This is the standard ESM bridge — the banner runs before the shim is
  // created, so it is defined by the time it is needed.
  banner: {
    js: [
      '#!/usr/bin/env node',
      '// LifeMentor server — bundled entry point (dist/main.mjs)',
      'import { createRequire as __lmCreateRequire } from "node:module";',
      'const require = __lmCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
