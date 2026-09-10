import { userError } from './errors';

/**
 * Reads what a screen needs without hiding the failure (phase-20 hardening).
 *
 * Every screen used to end its loaders with `.catch(() => undefined)`: when a read really failed —
 * a closed driver, a corrupt row, a bug in a query — the state simply stayed `null`. The user then
 * saw a spinner that would never stop, or an empty list indistinguishable from real, empty data,
 * and the only symptom of a broken database was that the app looked new.
 *
 * `loadSafely` keeps the one-shot read and the `!stop` guard, but hands a failure to the screen,
 * which says what happened and offers «Повторить». The internal message still goes to the console.
 */
export function loadSafely<T>(
  promise: Promise<T>,
  handlers: { ok: (value: T) => void; fail: (message: string) => void; alive?: () => boolean },
): void {
  const alive = (): boolean => !handlers.alive || handlers.alive();
  promise
    .then((value) => { if (alive()) handlers.ok(value); })
    .catch((error: unknown) => {
      console.warn('[lifementor] screen load failed:', error instanceof Error ? error.message : error);
      if (alive()) handlers.fail(userError(error));
    });
}

/**
 * A deliberately non-fatal write — a last screen, a chat draft, a background poll. It must not
 * disturb the user with an error, because nothing they asked for failed; but it must not disappear
 * either, or a silently broken draft looks exactly like a working one.
 */
export function bestEffort(promise: Promise<unknown>, what: string): void {
  void promise.catch((error: unknown) =>
    console.warn(`[lifementor] ${what} failed (non-fatal):`, error instanceof Error ? error.message : error));
}
