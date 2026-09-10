import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The monorepo root, resolved from this file's own location.
 *
 * Both `src/` (dev, tsx) and `dist/` (bundled release) sit directly under
 * `apps/server` (`<root>/apps/server/{src,dist}`), so three levels up is the
 * repository root in both modes. The
 * server's deployment unit is the repository itself, so this is stable.
 *
 * Why: `npm run … --workspace @lifementor/server` executes scripts with the
 * workspace directory (`apps/server`) as cwd, so anything resolved against
 * `process.cwd()` silently lands one level too deep (req. 17: no surprises).
 */
const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..', '..', '..');
