/**
 * Capacitor (Android) shell adapter — loaded ONLY when the app runs inside the
 * Android webview (`window.Capacitor` is present), so the browser preview bundle
 * never loads these native bridges (the module is a separate, code-split chunk).
 *
 * It injects the `PlatformAdapter` the core expects:
 *   secureStorage  → @capacitor/preferences (SharedPreferences)
 *   notifications  → @capacitor/local-notifications (real OS scheduling — fires even
 *                    with the app in the background; req. 87 context is carried in `extra`)
 *   files          → @capacitor/filesystem (+ share sheet); webview file input for import
 *   network        → @capacitor/network
 *   device         → @capacitor/app
 * and the native SQLite driver (platform SQLite, WAL — same schema as web/desktop).
 *
 * AI provider keys still never touch the device: the AI gateway is server-side (req. 20).
 */
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { CapacitorSQLite } from '@capacitor-community/sqlite';
import type { PlatformAdapter, SqlDriver } from '@lifementor/core';
import { CapacitorSqlDriver } from '@lifementor/core/capacitor';

export function isCapacitorRuntime(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    (globalThis as Record<string, unknown>).Capacitor !== undefined
  );
}

/* ── secure storage (SharedPreferences) ───────────────────────────────── */
const secureStorage = {
  get: async (key: string): Promise<string | null> => (await Preferences.get({ key })).value ?? null,
  set: async (key: string, value: string): Promise<void> => {
    await Preferences.set({ key, value });
  },
  remove: async (key: string): Promise<void> => {
    await Preferences.remove({ key });
  },
};

/* ── notifications (OS-level, survives app backgrounding) ────────────── */
function toNotificationId(id: number | string): number {
  if (typeof id === 'number') return id;
  // Stable FNV-1a 32-bit hash → positive int (Android notification ids are 32-bit ints).
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_000_000_000;
}

function toData(data?: Record<string, unknown>): Record<string, string> | undefined {
  if (!data) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
}

type ShellNotification = { id: number | string; title: string; body: string; at?: string; data?: Record<string, unknown> };

const notifications = {
  isSupported: (): boolean => Capacitor.isNativePlatform(),
  async requestPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (!Capacitor.isNativePlatform()) return 'unsupported';
    const res = await LocalNotifications.requestPermissions();
    return res.display === 'granted' ? 'granted' : 'denied';
  },
  async schedule(items: ShellNotification[]): Promise<void> {
    if (!items.length) return;
    // v8.3+ requests POST_NOTIFICATIONS itself when needed; we pre-request anyway.
    await LocalNotifications.schedule({
      notifications: items.map((it) => ({
        id: toNotificationId(it.id),
        title: it.title,
        body: it.body,
        extra: toData(it.data),
        schedule: { at: new Date(it.at ?? Date.now()) },
      })),
    });
  },
  async cancel(ids: (number | string)[]): Promise<void> {
    if (!ids.length) return;
    await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id: toNotificationId(id) })) });
  },
  async cancelAll(): Promise<void> {
    await LocalNotifications.cancelAll();
  },
  async showNow(item: ShellNotification): Promise<void> {
    // The plugin has no "fire now" method — schedule one millisecond in the future.
    await LocalNotifications.schedule({
      notifications: [{
        id: toNotificationId(item.id),
        title: item.title,
        body: item.body,
        extra: toData(item.data),
        schedule: { at: new Date(Date.now() + 1) },
      }],
    });
  },
};

/* ── files ───────────────────────────────────────────────────────────── */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const files = {
  async saveFile(filename: string, content: string | Uint8Array): Promise<void> {
    // v8: base64 data without `encoding` = binary; Encoding.UTF8 = text.
    const saved =
      content instanceof Uint8Array
        ? await Filesystem.writeFile({ path: filename, data: uint8ToBase64(content), directory: Directory.Documents })
        : await Filesystem.writeFile({ path: filename, data: content, directory: Directory.Documents, encoding: Encoding.UTF8 });
    // Hand the file to the Android share sheet so the user can keep it in their own
    // storage (Documents/…, cloud drive, messenger) — the app sandbox is not theirs.
    try {
      await Share.share({ title: filename, url: saved.uri, dialogTitle: filename });
    } catch { /* share sheet declined — the file is still in the app Documents directory */ }
  },
  async pickFile(accept?: string): Promise<{ name: string; content: string } | null> {
    // The Android webview supports the standard file input; no native plugin needed.
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, content: String(reader.result ?? '') });
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  },
};

/* ── network ─────────────────────────────────────────────────────────── */
class CapacitorNetwork {
  private listeners = new Set<(online: boolean) => void>();
  private online = typeof navigator === 'undefined' ? true : navigator.onLine;

  constructor() {
    if (!Capacitor.isNativePlatform()) return;
    void Network.addListener('networkStatusChange', (state) => {
      this.online = state.connected;
      for (const l of this.listeners) l(state.connected);
    });
  }
  isOnline(): boolean { return this.online; }
  onChange(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/* ── device ──────────────────────────────────────────────────────────── */
async function deviceInfo(): Promise<{ id: string; name: string; platform: string; osVersion?: string; appVersion?: string }> {
  const stored = await secureStorage.get('lifementor.device_id');
  let id = stored;
  if (!id) {
    id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `android-${Date.now()}`;
    await secureStorage.set('lifementor.device_id', id);
  }
  let appVersion: string | undefined;
  try {
    const info = await CapacitorApp.getInfo();
    appVersion = info.version;
  } catch { /* optional */ }
  return {
    id,
    name: `Android (Capacitor)`,
    platform: 'android',
    appVersion,
  };
}

export function createCapacitorPlatform(): PlatformAdapter {
  return {
    name: 'android',
    secureStorage,
    notifications,
    files,
    network: new CapacitorNetwork(),
    device: deviceInfo,
  };
}

/** Native SQLite driver for the shell (platform SQLite, WAL, real transactions). */
export function createCapacitorDriver(): SqlDriver {
  return new CapacitorSqlDriver({ path: 'lifementor.sqlite', plugin: CapacitorSQLite });
}
