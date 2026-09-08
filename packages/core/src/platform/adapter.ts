/**
 * Platform adapter — the only place where platform-specific capabilities live
 * (secure storage, OS notifications, file save/open, network status, device identity).
 * Implementations: web (browser dev preview), node (server/CLI/tests), and the shell
 * adapters injected by the Tauri (Windows) and Capacitor (Android) apps.
 */

export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ScheduledNotification {
  id: number | string;
  title: string;
  body: string;
  at: string;                 // ISO
  data?: Record<string, unknown>;
}

export interface NotificationBridge {
  isSupported(): boolean;
  requestPermission(): Promise<'granted' | 'denied' | 'unsupported'>;
  schedule(items: ScheduledNotification[]): Promise<void>;
  cancel(ids: (number | string)[]): Promise<void>;
  cancelAll(): Promise<void>;
  showNow(item: ScheduledNotification): Promise<void>;
}

export interface FileBridge {
  /** Save a text/binary file chosen by the user (export, backup). */
  saveFile(filename: string, content: string | Uint8Array, mime?: string): Promise<void>;
  /** Let the user pick a file and read it (import, restore). */
  pickFile(accept?: string): Promise<{ name: string; content: string } | null>;
}

export interface NetworkBridge {
  isOnline(): boolean;
  onChange(listener: (online: boolean) => void): () => void;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: 'web' | 'windows' | 'android' | 'node' | string;
  osVersion?: string;
  appVersion?: string;
}

export interface PlatformAdapter {
  readonly name: DeviceInfo['platform'];
  readonly secureStorage: SecureStorage;
  readonly notifications: NotificationBridge;
  readonly files: FileBridge;
  readonly network: NetworkBridge;
  device(): Promise<DeviceInfo>;
  setBadge?(count: number): Promise<void>;
  vibrate?(pattern: number[]): Promise<void>;
}

// ────────────────────────────── web implementation ──────────────────────────────
class WebSecureStorage implements SecureStorage {
  /** Tokens live in sessionStorage in the browser preview; shells use the OS key store. */
  async get(key: string): Promise<string | null> {
    try { return globalThis.sessionStorage?.getItem(key) ?? globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  }
  async set(key: string, value: string): Promise<void> {
    try { globalThis.sessionStorage?.setItem(key, value); } catch { /* private mode */ }
  }
  async remove(key: string): Promise<void> {
    try { globalThis.sessionStorage?.removeItem(key); globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
  }
}

class WebNotifications implements NotificationBridge {
  isSupported(): boolean { return typeof globalThis.Notification !== 'undefined'; }
  async requestPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (!this.isSupported()) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  }
  /** The browser cannot schedule future notifications; the app re-schedules on load and uses timers. */
  async schedule(items: ScheduledNotification[]): Promise<void> {
    for (const item of items) scheduleTimer(item, () => void this.showNow(item));
  }
  async cancel(ids: (number | string)[]): Promise<void> { for (const id of ids) cancelTimer(id); }
  async cancelAll(): Promise<void> { clearTimers(); }
  async showNow(item: ScheduledNotification): Promise<void> {
    if (!this.isSupported() || Notification.permission !== 'granted') return;
    try { new Notification(item.title, { body: item.body, tag: String(item.id) }); } catch { /* ignore */ }
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleTimer(item: ScheduledNotification, run: () => void): void {
  const delay = Math.max(0, new Date(item.at).getTime() - Date.now());
  cancelTimer(item.id);
  timers.set(String(item.id), setTimeout(run, Math.min(delay, 2 ** 31 - 1)));
}
function cancelTimer(id: number | string): void {
  const existing = timers.get(String(id));
  if (existing) { clearTimeout(existing); timers.delete(String(id)); }
}
function clearTimers(): void { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

class WebFiles implements FileBridge {
  async saveFile(filename: string, content: string | Uint8Array, mime = 'application/octet-stream'): Promise<void> {
    const blob = content instanceof Uint8Array ? new Blob([content as BlobPart], { type: mime }) : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async pickFile(accept?: string): Promise<{ name: string; content: string } | null> {
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
  }
}

class WebNetwork implements NetworkBridge {
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

export class WebPlatformAdapter implements PlatformAdapter {
  readonly name = 'web' as const;
  readonly secureStorage = new WebSecureStorage();
  readonly notifications = new WebNotifications();
  readonly files = new WebFiles();
  readonly network = new WebNetwork();

  async device(): Promise<DeviceInfo> {
    const stored = await this.secureStorage.get('lifementor.device_id');
    let id = stored;
    if (!id) {
      id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `web-${Date.now()}`;
      await this.secureStorage.set('lifementor.device_id', id);
    }
    return { id, name: browserName(), platform: 'web', appVersion: '0.1.0' };
  }
}

function browserName(): string {
  if (typeof navigator === 'undefined') return 'Browser';
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

// ────────────────────────────── node implementation ──────────────────────────────
export class NodePlatformAdapter implements PlatformAdapter {
  readonly name = 'node' as const;
  private readonly store = new Map<string, string>();
  readonly secureStorage: SecureStorage = {
    get: async (key) => this.store.get(key) ?? null,
    set: async (key, value) => { this.store.set(key, value); },
    remove: async (key) => { this.store.delete(key); },
  };
  readonly notifications: NotificationBridge = {
    isSupported: () => false,
    requestPermission: async () => 'unsupported',
    schedule: async () => undefined,
    cancel: async () => undefined,
    cancelAll: async () => undefined,
    showNow: async () => undefined,
  };
  readonly files: FileBridge = {
    saveFile: async (filename, content) => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(filename, content as string | Uint8Array);
    },
    pickFile: async () => null,
  };
  readonly network: NetworkBridge = {
    isOnline: () => true,
    onChange: () => () => undefined,
  };

  constructor(private readonly deviceId = 'node-device') {}

  async device(): Promise<DeviceInfo> {
    const os = await import('node:os');
    return { id: this.deviceId, name: os.hostname(), platform: 'node', osVersion: `${os.type()} ${os.release()}`, appVersion: '0.1.0' };
  }
}

export function detectPlatform(): PlatformAdapter['name'] {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__TAURI_INTERNALS__ !== 'undefined' || typeof g.__TAURI__ !== 'undefined') return 'windows';
  if (typeof g.Capacitor !== 'undefined') return 'android';
  if (typeof window !== 'undefined' && typeof document !== 'undefined') return 'web';
  return 'node';
}

/**
 * Default adapter for the current runtime. The Windows (Tauri) and Android (Capacitor) shells
 * inject their own adapter into the app container, because they provide OS secure storage,
 * native notifications and filesystem access.
 */
export function createDefaultPlatform(): PlatformAdapter {
  return detectPlatform() === 'web' ? new WebPlatformAdapter() : new NodePlatformAdapter();
}
