// @vitest-environment jsdom
/**
 * Route-level code splitting (phase-20 performance).
 *
 * The check in `scripts/check-client-budget.mjs` proves the *built* bundle is split, but it needs a
 * build first. This one reads `App.tsx` directly and fails in a second: every screen is reached
 * through `lazy(() => import(...))`, and every route renders its screen inside `<Screen>` (the
 * Suspense boundary in the shell's content area). One eager `import { Settings } from './screens/…'`
 * would put a 800-line screen back into the startup download, which is exactly what the packaged
 * Windows/Android client pays for before the first screen appears.
 */
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, '..', 'src');
const app = readFileSync(join(webSrc, 'App.tsx'), 'utf8');

/** The lazy bindings: `const Dashboard = lazy(() => import('./screens/Dashboard')…`. */
function lazyBindings(): { name: string; module: string }[] {
  return [...app.matchAll(/const (\w+) = lazy\(\(\) => import\('\.\/screens\/([\w.-]+)'\)/g)]
    .map((m) => ({ name: m[1], module: m[2] }));
}

function screenFiles(): string[] {
  return readdirSync(join(webSrc, 'screens')).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, ''));
}

describe('the client loads screens on demand', () => {
  it('reaches every screen through a lazy import', () => {
    const bindings = lazyBindings();
    const modules = bindings.map((b) => b.module).sort();
    // Every screen file in the client must be lazy: a screen that is not listed here is either
    // unreachable (dead file) or imported eagerly (startup cost).
    expect(modules).toEqual(screenFiles().sort());
  });

  it('has no eager screen import left in the router', () => {
    const eager = [...app.matchAll(/^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+'\.\/screens\/[\w.-]+';?$/gm)].map((m) => m[0]);
    expect(eager, `экраны, загружаемые сразу: ${eager.join(' | ')}`).toEqual([]);
    // …and the guard is not vacuous: the shell itself is still imported eagerly.
    expect(app).toMatch(/^import\s+\{[^}]*\}\s+from\s+'\.\/components\/ui';?$/m);
  });

  it('wraps every screen route in the Suspense boundary', () => {
    const screens = lazyBindings().map((b) => b.name);
    const routes = [...app.matchAll(/<Route path="\/[\w-]*" element=\{([\s\S]*?)\} \/>/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThanOrEqual(16);
    for (const element of routes) {
      const used = screens.filter((name) => new RegExp(`<${name}\\s*/>`).test(element));
      if (!used.length) continue; // `/` and `*` are redirects, not screens
      for (const name of used) {
        expect(new RegExp(`<Screen>\\s*<${name}\\s*/>\\s*</Screen>`).test(element),
          `экран ${name} отрисован без <Screen>`).toBe(true);
      }
    }
  });

  it('keeps the first-run path lazy too — onboarding must not ride along with the whole product', () => {
    const modules = lazyBindings().map((b) => b.module);
    expect(modules).toContain('Onboarding');
    expect(modules).toContain('Auth');
  });
});
