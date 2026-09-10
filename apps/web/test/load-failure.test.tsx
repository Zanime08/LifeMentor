// @vitest-environment jsdom
/**
 * A screen that cannot read its data must say so (phase-20 hardening, req. 95).
 *
 * Every screen used to end its loaders with `.catch(() => undefined)`. That made a *broken* read
 * indistinguishable from an *empty* account: the state stayed `null` and the screen either spun
 * forever (the Knowledge screen did exactly that for a different reason and nobody noticed for
 * weeks) or rendered an empty list. The one outcome that must never happen is a lie — «ничего не
 * нашлось» about a query that never ran, or «пересечений нет» about a check that failed.
 *
 * Three guards: the pattern is gone from the client, failures reach the UI, and deliberately
 * non-fatal work still reports itself in the console instead of vanishing.
 */
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LoadFailure } from '../src/components/ui';
import { bestEffort, loadSafely } from '../src/lib/load';

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, '..', 'src');

/** Every client source file, minus comments (the reason for this test is written in them). */
function clientSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) {
        const raw = readFileSync(full, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        out.push({ path: full.slice(webSrc.length + 1), code });
      }
    }
  };
  walk(webSrc);
  return out;
}

afterEach(() => cleanup());

describe('a failed screen load is never invisible', () => {
  it('has no silent `.catch(() => undefined)` left in the client', () => {
    const silent = clientSources()
      .filter((f) => f.path !== join('lib', 'load.ts'))
      .filter((f) => /\.catch\(\s*\(\s*\)\s*=>\s*(undefined|\{\s*\})\s*\)/.test(f.code))
      .map((f) => f.path);
    // Failures go through `loadSafely` (visible state + retry) or `bestEffort` (console), so the
    // list stays empty; a new screen that swallows a read turns this red.
    expect(silent, `экраны со «съеденной» ошибкой: ${silent.join(', ')}`).toEqual([]);
    // …and the guard must actually be looking at the client.
    expect(clientSources().length).toBeGreaterThan(25);
  });

  it('hands a rejection to the screen and keeps the internal message in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fail = vi.fn();
    loadSafely(Promise.reject(new Error('Insert into goals did not return a row')), { ok: () => undefined, fail });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
    // The user-facing sentence comes from `userError`, not from the engine.
    expect(fail.mock.calls[0][0]).toBe('Не удалось сохранить изменение. Попробуйте ещё раз.');
    expect(String(warn.mock.calls[0][0])).toContain('screen load failed');
    expect(String(warn.mock.calls[0][1])).toContain('did not return a row');
    warn.mockRestore();
  });

  it('drops the result of a load whose screen is already gone', async () => {
    const ok = vi.fn();
    let alive = true;
    loadSafely(Promise.resolve('rows'), { ok, fail: () => undefined, alive: () => alive });
    alive = false;
    await new Promise((r) => setTimeout(r, 10));
    expect(ok).not.toHaveBeenCalled();
  });

  it('keeps deliberately non-fatal work quiet but not invisible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => bestEffort(Promise.reject(new Error('draft write failed')), 'chat draft save')).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0][0])).toContain('non-fatal');
    expect(() => bestEffort(Promise.resolve(), 'anything')).not.toThrow();
    warn.mockRestore();
  });

  it('renders the failure with what failed, the reason and a retry', () => {
    const retry = vi.fn();
    render(<LoadFailure what="навыки" message="Что-то пошло не так. Попробуйте ещё раз." onRetry={retry} />);
    expect(screen.getByText('Не удалось загрузить навыки')).toBeTruthy();
    const hint = screen.getByText(/Что-то пошло не так/);
    expect(hint.textContent).toContain('Данные на диске не тронуты');
    screen.getByRole('button', { name: 'Повторить' }).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
