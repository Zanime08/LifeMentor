/**
 * Web bootstrap — local-first LifeMentor in the browser, and inside the
 * Windows (Tauri) / Android (Capacitor) shells.
 *
 * The same bundle runs in all three environments; the local SQLite database is:
 *   • browser preview — WASM SQLite in IndexedDB/OPFS: every write is committed
 *     immediately and flushed to durable storage right after COMMIT, so closing
 *     the tab or losing power never loses confirmed data;
 *   • Windows shell   — a real rusqlite connection owned by the Rust side (WAL);
 *   • Android shell   — the platform SQLite via the Capacitor plugin (WAL).
 * All three use the exact same schema (packages/core) — only the engine binding differs.
 *
 * The server (same origin in the dev preview via the Vite proxy; configurable in
 * Settings inside the shells) provides auth, sync, news and the AI gateway.
 * AI provider keys never reach the client — it only authenticates (req. 20, 58).
 */
import { LifeMentorApp, type LifeMentorOptions, type SqlDriver, type PlatformAdapter } from '@lifementor/core';
import { IndexedDbPersistence } from '@lifementor/core/wasm';

/**
 * Server base URL.
 *
 * Resolution order:
 *  1. `lifementor.serverUrl` in localStorage — set from Settings → Sync (the Tauri/Capacitor
 *     shells need this, because `window.location.origin` there is tauri:// / capacitor://,
 *     not a deployable server);
 *  2. `window.location.origin` — the dev preview, where Vite proxies /v1 to the server.
 *
 * Changing the URL in settings writes localStorage and reloads, so every transport (AI
 * gateway, sync, auth, news, push, cloud backup) picks it up at bootstrap.
 */
export const SERVER_URL_STORAGE_KEY = 'lifementor.serverUrl';

export function getServerUrl(): string {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(SERVER_URL_STORAGE_KEY) : null;
    if (stored) {
      const trimmed = stored.trim().replace(/\/+$/, '');
      if (trimmed) return trimmed;
    }
  } catch { /* storage unavailable — fall through to origin */ }
  return window.location.origin;
}

/** Fixed at bootstrap; settings writes to localStorage and reloads to apply. */
export const SERVER_URL: string = getServerUrl();

let appPromise: Promise<LifeMentorApp> | null = null;

export function bootstrapApp(): Promise<LifeMentorApp> {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const g = globalThis as Record<string, unknown>;
    const isTauri = g.__TAURI_INTERNALS__ !== undefined || g.__TAURI__ !== undefined;
    const isCapacitor = g.Capacitor !== undefined;

    // Shell bindings are code-split chunks — the browser preview never loads them.
    let driver: SqlDriver | undefined;
    let platform: PlatformAdapter | undefined;
    if (isTauri) {
      const shell = await import('../shells/tauri');
      driver = await shell.createTauriDriver();
      platform = shell.createTauriPlatform();
    } else if (isCapacitor) {
      const shell = await import('../shells/capacitor');
      driver = shell.createCapacitorDriver();
      platform = shell.createCapacitorPlatform();
    }

    const options: LifeMentorOptions = {
      ...(driver
        ? { driver, platform: platform! }
        : {
            driverOptions: {
              kind: 'wasm',
              persistence: new IndexedDbPersistence('lifementor', 'sqlite', 'main'),
              wasmUrl: '/sql-wasm.wasm',
            },
          }),
      ai: {
        // Gateway provider: the model runs on the server, tools execute locally.
        // Without a reachable server (or while signed out) the orchestrator
        // falls back to the built-in offline heuristic engine automatically.
        providers: [{ kind: 'gateway', gateway: { serverUrl: SERVER_URL } }],
        embeddings: 'local',
      },
      sync: { serverUrl: SERVER_URL, autoStart: true, intervalMs: 30_000 },
      auth: { serverUrl: SERVER_URL },
      backup: { onFirstLaunch: true },
    };
    const app = await LifeMentorApp.create(options);
    await initLanguage(app);
    return app;
  })().catch((error) => {
    appPromise = null; // allow retry
    throw error;
  });
  return appPromise;
}

/**
 * Decide the language the app speaks to this user, once per installation (req. 6, 7, 20).
 *
 * The engine's own defaults are English, which means a Russian user — the whole interface is
 * Russian — used to get: an English «вот как я вас понял» summary, goal drafts titled
 * "Learn X to a usable level", and review narratives written in English, because that is the
 * language handed to the AI and to the onboarding composers. The browser (or the shell) knows the
 * language of the person in front of it, so it is applied on the first launch; after that the choice
 * belongs to the user and is only ever changed in Settings.
 *
 * Device-local on purpose: it is a statement about *this* device's user, not data to sync.
 */
export async function initLanguage(app: LifeMentorApp, browserLanguage = typeof navigator !== 'undefined' ? navigator.language : ''): Promise<string | null> {
  try {
    const flags = await app.services.settings.get('flags');
    const current = await app.services.settings.get('ai');
    if (flags.language_initialized) return current.language;
    const language = (browserLanguage || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
    await app.services.settings.setMany({ ai: { language }, profile: { locale: language } }, { actor: 'system', sync: false });
    await app.services.settings.set('flags', { language_initialized: true }, { actor: 'system', sync: false });
    return language;
  } catch {
    // Never block the app on a convenience: the settings keep their defaults.
    return null;
  }
}

/** Force-close the app (used by "reset local data" / account deletion flows). */
export async function resetAppPromise(): Promise<void> {
  if (appPromise) {
    try {
      const app = await appPromise;
      await app.close();
    } catch { /* already closed */ }
    appPromise = null;
  }
}
