/**
 * Web bootstrap — local-first LifeMentor in the browser.
 *
 * The local SQLite database (WASM build of the exact same schema the desktop
 * and Android shells use) lives in IndexedDB / OPFS: every write is committed
 * to the DB immediately and the image is flushed to durable storage right
 * after COMMIT, so closing the tab or losing power never loses confirmed data.
 *
 * The server (same origin in the dev preview via the Vite proxy) provides
 * auth, sync, news and the AI gateway. AI provider keys never reach the
 * browser — the client only authenticates (req. 20, 58).
 */
import { LifeMentorApp, type LifeMentorOptions } from '@lifementor/core';
import { IndexedDbPersistence } from '@lifementor/core/wasm';

/**
 * Server base URL. In the dev preview the Vite proxy forwards /v1 to the
 * LifeMentor server, so same-origin works out of the box. In the Tauri /
 * Capacitor shells this is the deployed https:// URL from settings.
 */
export const SERVER_URL: string = window.location.origin;

let appPromise: Promise<LifeMentorApp> | null = null;

export function bootstrapApp(): Promise<LifeMentorApp> {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const options: LifeMentorOptions = {
      driverOptions: {
        kind: 'wasm',
        persistence: new IndexedDbPersistence('lifementor', 'sqlite', 'main'),
        wasmUrl: '/sql-wasm.wasm',
      },
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
    return app;
  })().catch((error) => {
    appPromise = null; // allow retry
    throw error;
  });
  return appPromise;
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
