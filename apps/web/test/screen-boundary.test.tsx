// @vitest-environment jsdom
/**
 * A screen that cannot load must not take the app down (phase-20 hardening).
 *
 * Screens are lazy chunks now, and React's answer to a rejected dynamic import is to unmount the
 * whole tree: the user would get a white page with no message — the worst failure mode this app can
 * have, and the one that is most likely on a bad connection. `ScreenErrorBoundary` (inside the
 * shell, around the Suspense boundary) turns it into a sentence and a reload button, while the
 * navigation, the top bar and the bell keep working.
 */
import React, { Suspense, lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ScreenErrorBoundary } from '../src/App';
import { userError } from '../src/lib/errors';

afterEach(() => cleanup());

describe('a screen chunk that fails to load', () => {
  it('shows the failure inside the shell instead of a white page', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Settings-x.js')));
    render(
      <div>
        <nav>sidebar</nav>
        <main>
          <Suspense fallback={<div>Открываю экран…</div>}>
            <ScreenErrorBoundary>
              <Broken />
            </ScreenErrorBoundary>
          </Suspense>
        </main>
      </div>,
    );
    // The fallback appears while the chunk is being fetched…
    expect(screen.getByText('Открываю экран…')).toBeTruthy();
    // …and the rejection becomes a real message, not a blank area.
    await waitFor(() => expect(screen.getByText('Не удалось загрузить экран')).toBeTruthy());
    expect(screen.getByText(/Не удалось загрузить этот экран/).textContent).toContain('Проверьте подключение');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
    // The rest of the application is untouched — only the screen area failed.
    expect(screen.getByText('sidebar')).toBeTruthy();
    // The crash is reported for support (React logs its own trace as well, hence the search).
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('screen crashed');
    error.mockRestore();
  });

  it('catches a screen that crashes while rendering, and says which screen it was', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = (): React.ReactNode => { throw new Error('Insert into goals did not return a row'); };
    render(<ScreenErrorBoundary what="цели"><Boom /></ScreenErrorBoundary>);
    await waitFor(() => expect(screen.getByText('Не удалось загрузить цели')).toBeTruthy());
    // The user-facing sentence comes from `userError`, never from the engine.
    expect(screen.getByText(/Не удалось сохранить изменение/)).toBeTruthy();
    error.mockRestore();
  });

  it('writes the message a chunk error deserves, not the sync one', () => {
    expect(userError(new Error('Failed to fetch dynamically imported module: /assets/x.js')))
      .toBe('Не удалось загрузить этот экран. Проверьте подключение и попробуйте ещё раз.');
    // A real network failure of a server call keeps its own wording.
    expect(userError(new Error('TypeError: Failed to fetch'))).toContain('Сервер недоступен');
  });
});
