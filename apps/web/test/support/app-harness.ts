/**
 * UI test harness (req. 93 — UI-level tests without a browser).
 *
 * The web screens are just a view over `LifeMentorApp`: they own no data and no
 * logic. This module gives a test a **real** app instance — real SQLite, real
 * migrations, real services, real planner, real AI orchestrator — on a real file in
 * a temp directory, so "restart the app" in a test means exactly what it means for
 * the user: close the connection, open the same database again.
 *
 * It also implements the module surface `apps/web/src/core/app.ts` exposes, so the
 * test can install it with `vi.mock('../src/core/app', …)` and the production store
 * (`state/store.tsx`) boots normally — the gate, the onboarding redirect and the
 * error paths are the same code that runs in the browser.
 *
 * The server URL points at a closed port on purpose: the browser preview must stay
 * fully usable offline (local-first, req. 60), degrading AI to the offline engine
 * and reporting an honest offline sync state instead of crashing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp, type BackupStorage, type BackupFile, type LifeMentorOptions } from '@lifementor/core';

/** Closed port — guaranteed unreachable, exactly like a laptop with no Wi-Fi. */
export const SERVER_URL = 'http://127.0.0.1:9';
/** Mirrors the real module: the Settings screen imports this key when the user edits the server URL. */
export const SERVER_URL_STORAGE_KEY = 'lifementor.serverUrl';

const directory = mkdtempSync(join(tmpdir(), 'lifementor-ui-'));
const databasePath = join(directory, 'lifementor-ui.sqlite');

/** Backups live in memory here: jsdom has no OPFS, and the bytes are not the point in a UI test. */
export class MemoryBackupStorage implements BackupStorage {
  readonly kind = 'memory' as const;
  private readonly files = new Map<string, Uint8Array>();
  async write(name: string, bytes: Uint8Array): Promise<string> {
    const path = `/backups/${name}`;
    this.files.set(path, bytes);
    return path;
  }
  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`no such backup: ${path}`);
    return bytes;
  }
  async list(): Promise<BackupFile[]> {
    return [...this.files.entries()].map(([path, bytes]) => ({ name: path.slice('/backups/'.length), path, size: bytes.byteLength, modified: new Date().toISOString() }));
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  describe(): string { return 'memory:ui-test'; }
}

function options(): LifeMentorOptions {
  return {
    deviceId: 'device-ui-test',
    driverOptions: { kind: 'node', path: databasePath },
    ai: { providers: [{ kind: 'gateway', gateway: { serverUrl: SERVER_URL } }], embeddings: 'local' },
    sync: { serverUrl: SERVER_URL, autoStart: true, intervalMs: 3_600_000 },
    auth: { serverUrl: SERVER_URL },
    backup: { onFirstLaunch: true, storage: new MemoryBackupStorage() },
    // The UI tests are about screens, not about time-driven maintenance: without this the first
    // launch kicks off a background pass (snapshots, review of the ended period, retention) whose
    // timers run while tests navigate and would make failures depend on the wall clock.
    maintenance: { enabled: false },
  };
}

let current: LifeMentorApp | null = null;
let pending: Promise<LifeMentorApp> | null = null;

/** Mirrors `bootstrapApp()` from apps/web/src/core/app.ts. */
export function bootstrapApp(): Promise<LifeMentorApp> {
  if (pending) return pending;
  pending = LifeMentorApp.create(options())
    .then((app) => { current = app; return app; })
    .catch((error) => { pending = null; throw error; });
  return pending;
}

/** Mirrors `resetAppPromise()`: close and open again on the next bootstrap. */
export async function resetAppPromise(): Promise<void> {
  if (pending) {
    try {
      const app = await pending;
      await app.close();
    } catch { /* already closed */ }
  }
  pending = null;
  current = null;
}

/** The open app (for assertions that are about data, not pixels). */
export function openApp(): LifeMentorApp | null { return current; }

/**
 * Close the app *without* deleting anything — the next `bootstrapApp()` opens the same
 * file. This is the "user killed the process / rebooted the machine" path (req. 94).
 */
export async function restartApp(): Promise<void> {
  await resetAppPromise();
}

export async function disposeHarness(): Promise<void> {
  await resetAppPromise();
  rmSync(directory, { recursive: true, force: true });
}

export function databaseFile(): string { return databasePath; }
