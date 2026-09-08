/**
 * Web Push client (docs/08 §5).
 *
 * The browser side of the two-path notification design:
 *  - **push**: the server's service worker receives Web Push and shows a system notification
 *    even when the tab is closed;
 *  - **polling fallback**: on every foreground (and every minute while open) we pull
 *    `GET /v1/notifications/pending`, so anything the push missed still arrives. Each item is
 *    passed through the local NotificationService gate (budget / quiet hours / per-type
 *    switches) — the device is the final arbiter (req. 86).
 */
import type { LifeMentorApp, NotificationType } from '@lifementor/core';
import { SERVER_URL } from './core/app';

export type PushState =
  | { supported: false; reason: string }
  | { supported: true; permission: NotificationPermission; subscribed: boolean };

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && window.isSecureContext
  );
}

export function pushUnsupportedReason(): string {
  if (typeof window === 'undefined') return 'not a browser';
  if (!window.isSecureContext) return 'requires HTTPS';
  if (!('serviceWorker' in navigator)) return 'Service Worker unavailable';
  if (!('PushManager' in window)) return 'PushManager unavailable';
  if (!('Notification' in window)) return 'Notifications unavailable';
  return 'unsupported';
}

function authHeaders(app: LifeMentorApp): Promise<Record<string, string>> {
  return app.services.auth.accessToken().then((token) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  });
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { ...init, headers: { ...init?.headers } });
  if (!res.ok) throw new Error(`server responded ${res.status}`);
  return res.json() as Promise<T>;
}

/** Convert the base64url VAPID key to the bytes PushManager wants. */
export function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function getPushState(app: LifeMentorApp): Promise<PushState> {
  if (!pushSupported()) return { supported: false, reason: pushUnsupportedReason() };
  const permission = Notification.permission;
  let subscribed = false;
  if (permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      subscribed = sub !== null;
    } catch { subscribed = false; }
  }
  return { supported: true, permission, subscribed };
}

/** Ask permission, subscribe the service worker, register with the server. */
export async function enablePush(app: LifeMentorApp): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!pushSupported()) return { ok: false, error: pushUnsupportedReason() };
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: permission === 'denied' ? 'permission denied by the browser' : 'permission not granted' };

    const reg = await navigator.serviceWorker.register('/sw.js');
    const publicKey = (await fetchJson<{ publicKey: string }>('/v1/notifications/push/vapid-public-key', { headers: await authHeaders(app) })).publicKey;
    if (!publicKey) return { ok: false, error: 'server returned an empty VAPID key' };

    let sub = await reg.pushManager.getSubscription();
    sub = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const json = sub.toJSON();
    await fetchJson('/v1/notifications/push-token', {
      method: 'POST',
      headers: { ...(await authHeaders(app)), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'web', subscription: { endpoint: json.endpoint, keys: json.keys } }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Unsubscribe locally and tell the server to drop the endpoint. */
export async function disablePush(app: LifeMentorApp): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await sub.unsubscribe();
      try {
        await fetchJson('/v1/notifications/push-token', {
          method: 'DELETE',
          headers: { ...(await authHeaders(app)), 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch { /* offline — the server will drop the dead endpoint after a 410 */ }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Diagnostics: ask the server to push a test notification to this account. */
export async function sendTestPush(app: LifeMentorApp): Promise<{ ok: boolean; push?: string; error?: string }> {
  try {
    const result = await fetchJson<{ ok: boolean; push: string; error?: string }>('/v1/notifications/test', {
      method: 'POST',
      headers: await authHeaders(app),
    });
    return { ok: result.ok, push: result.push, error: result.error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ServerNotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  url: string | null;
  urgent: number;
  dedup_key: string | null;
}

/**
 * Pull everything the server queued while this tab was closed (or the push attempt failed).
 * Each item goes through the local gate, so budget/quiet-hours still apply on the device.
 */
export async function pollPendingNotifications(app: LifeMentorApp): Promise<{ fetched: number; shown: number }> {
  const token = await app.services.auth.accessToken();
  if (!token) return { fetched: 0, shown: 0 };

  const { notifications } = await fetchJson<{ notifications: ServerNotificationRow[] }>('/v1/notifications/pending?limit=50', {
    headers: { authorization: `Bearer ${token}` },
  });

  let shown = 0;
  for (const n of notifications) {
    try {
      const decision = await app.services.notifications.create({
        type: n.type,
        title: n.title,
        body: n.body || 'LifeMentor',
        importance: n.urgent ? 0.9 : 0.6,
        channel: 'push',
        dedupe_key: `server:${n.id}`,
        context: { server_id: n.id, url: n.url ?? undefined },
      });
      if (decision.delivered) shown += 1;
    } catch { /* one bad item must not block the rest */ }
    try {
      await fetchJson(`/v1/notifications/${n.id}/delivered`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    } catch { /* stays in the queue — retried next foreground */ }
  }
  return { fetched: notifications.length, shown };
}
