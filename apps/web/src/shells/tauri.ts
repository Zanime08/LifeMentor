/**
 * Tauri (Windows) shell adapter — loaded ONLY when the app runs inside the Tauri
 * webview (`window.__TAURI_INTERNALS__` is present), so the browser preview bundle
 * never loads these bridges (the module is a separate, code-split chunk).
 *
 * It injects the `PlatformAdapter` the core expects:
 *   secureStorage  → @tauri-apps/plugin-store (JSON store in the app data dir,
 *                    outside the webview; scoped to the user profile)
 *   notifications  → @tauri-apps/plugin-notification — native SCHEDULING via
 *                    Schedule.at(), so reminders fire even while the window is
 *                    closed (the OS owns the timer)
 *   files          → @tauri-apps/plugin-dialog + @tauri-apps/plugin-fs
 *   network        → webview online/offline events (WebView2)
 *   device         → @tauri-apps/api/app
 * and the native driver: the Rust side owns a real rusqlite connection
 * (WAL, busy timeout, FK) to %APPDATA%/ai.lifementor.app/data/lifementor.sqlite.
 *
 * AI provider keys still never touch the device: the AI gateway is server-side (req. 20).
 */
import { getVersion } from '@tauri-apps/api/app';
import { appDataDir, basename, join } from '@tauri-apps/api/path';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  Schedule,
  cancel as cancelNotification,
  cancelAll as cancelAllNotifications,
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { load as loadStore, type Store } from '@tauri-apps/plugin-store';
import type { PlatformAdapter, SqlDriver } from '@lifementor/core';
import { TauriSqlDriver } from '@lifementor/core/tauri';

export function isTauriRuntime(): boolean {
  const g = globalThis as Record<string, unknown>;
  return g.__TAURI_INTERNALS__ !== undefined || g.__TAURI__ !== undefined;
}

/** %APPDATA%/ai.lifementor.app/data/lifementor.sqlite — the Rust side opens exactly this path. */
export async function tauriDbPath(): Promise<string> {
  const dir = await appDataDir();
  return join(dir, 'data', 'lifementor.sqlite');
}

/* ── secure storage (tauri-plugin-store, JSON in app data dir) ────────── */
let storePromise: Promise<Store> | null = null;
function store(): Promise<Store> {
  storePromise ??= (async () => loadStore(await join(await appDataDir(), 'secure-store.json'), { autoSave: true, defaults: {} }))();
  return storePromise;
}

const secureStorage = {
  get: async (key: string): Promise<string | null> => {
    const value = await (await store()).get(key);
    return typeof value === 'string' ? value : null;
  },
  set: async (key: string, value: string): Promise<void> => {
    await (await store()).set(key, value);
  },
  remove: async (key: string): Promise<void> => {
    await (await store()).delete(key);
  },
};

/* ── notifications (system toasts, native future scheduling) ─────────── */
function toNotificationId(id: number | string): number {
  if (typeof id === 'number') return id;
  // Stable FNV-1a 32-bit hash (Tauri notification ids are 32-bit ints).
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_000_000_000;
}

const notifications = {
  isSupported: (): boolean => true,
  async requestPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (await isPermissionGranted()) return 'granted';
    const result = await requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  },
  async schedule(items: { id: number | string; title: string; body: string; at: string; data?: Record<string, unknown> }[]): Promise<void> {
    for (const item of items) {
      sendNotification({
        id: toNotificationId(item.id),
        title: item.title,
        body: item.body,
        extra: item.data,
        schedule: Schedule.at(new Date(item.at), false, true),
      });
    }
  },
  async cancel(ids: (number | string)[]): Promise<void> {
    if (!ids.length) return;
    await cancelNotification(ids.map(toNotificationId));
  },
  async cancelAll(): Promise<void> {
    await cancelAllNotifications();
  },
  async showNow(item: { id: number | string; title: string; body: string; data?: Record<string, unknown> }): Promise<void> {
    sendNotification({
      id: toNotificationId(item.id),
      title: item.title,
      body: item.body,
      extra: item.data,
    });
  },
};

/* ── files (native dialogs + fs) ─────────────────────────────────────── */
function filtersFromAccept(accept?: string): { name: string; extensions: string[] }[] {
  if (!accept) return [];
  return accept.split(',').map((a) => a.trim()).filter(Boolean).map((a) => ({
    name: a.replace(/^\./, ''),
    extensions: [a.replace(/^\./, '')],
  }));
}

const files = {
  async saveFile(filename: string, content: string | Uint8Array): Promise<void> {
    const path = await save({ defaultPath: filename, filters: filtersFromAccept(filename) });
    if (!path) return; // user cancelled
    if (content instanceof Uint8Array) await writeFile(path, content);
    else await writeTextFile(path, content);
  },
  async pickFile(accept?: string): Promise<{ name: string; content: string } | null> {
    const path = await open({ multiple: false, filters: filtersFromAccept(accept) });
    if (!path) return null;
    const text = await readTextFile(path);
    return { name: await basename(path), content: text };
  },
};

/* ── network (WebView2 fires standard online/offline) ────────────────── */
class TauriNetwork {
  isOnline(): boolean { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; }
  onChange(listener: (online: boolean) => void): () => void {
    if (typeof globalThis.addEventListener !== 'function') return () => undefined;
    const on = () => listener(true);
    const off = () => listener(false);
    globalThis.addEventListener('online', on);
    globalThis.addEventListener('offline', off);
    return () => { globalThis.removeEventListener('online', on); globalThis.removeEventListener('offline', off); };
  }
}

/* ── device ──────────────────────────────────────────────────────────── */
async function deviceInfo(): Promise<{ id: string; name: string; platform: string; osVersion?: string; appVersion?: string }> {
  const stored = await secureStorage.get('lifementor.device_id');
  let id = stored;
  if (!id) {
    id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `windows-${Date.now()}`;
    await secureStorage.set('lifementor.device_id', id);
  }
  let appVersion: string | undefined;
  try { appVersion = await getVersion(); } catch { /* optional */ }
  const os = navigator.userAgent.match(/Windows NT ([\d.]+)/);
  return {
    id,
    name: `Windows ${os ? os[1] : ''}`.trim(),
    platform: 'windows',
    osVersion: os ? `Windows NT ${os[1]}` : undefined,
    appVersion,
  };
}

export function createTauriPlatform(): PlatformAdapter {
  return {
    name: 'windows',
    secureStorage,
    notifications,
    files,
    network: new TauriNetwork(),
    device: deviceInfo,
  };
}

/** Native driver — the Rust side owns the connection (rusqlite, WAL). */
export async function createTauriDriver(): Promise<SqlDriver> {
  return new TauriSqlDriver({ path: await tauriDbPath(), durability: 'safe', busyTimeoutMs: 5000 });
}
