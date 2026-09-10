/**
 * FCM push for the Android shell (docs/08 §5, docs/11 §8).
 *
 * The server side is the FCM v1 API (apps/server/src/services/fcm.ts). This module is the
 * Android half:
 *  - registers the device's FCM token and posts it to `POST /v1/notifications/push-token`
 *    (kind 'fcm') so the server can reach this account;
 *  - when a message arrives while the app is in the foreground, it pulls the server queue
 *    through `pollPendingNotifications` — the same path (and the same local gate: budget /
 *    quiet hours / per-type switches, req. 86) as the polling fallback, deduped by the
 *    server's `delivered_at`;
 *  - when the app is closed, FCM itself shows the OS notification for URGENT messages
 *    (the server only marks `notification` on urgent items — see FcmMessage.urgent), and
 *    data-only messages are simply picked up on the next foreground.
 *
 * The Capacitor push-notifications import is dynamic on purpose: it must not enter the
 * plain web bundle, only the native shell's code-split chunk.
 *
 * Requires a Firebase project for package ai.lifementor.app (google-services.json —
 * docs/11 §8). Without it the plugin cannot obtain a token, registration fails, and the
 * app honestly keeps working via polling.
 */
import type { LifeMentorApp } from '@lifementor/core';
import { SERVER_URL } from '../core/app';

let listenersReady = false;
/** Register() was already called for this auth phase (signed-in / signed-out). */
let registeredPhase: 'authed' | 'anon' | null = null;
/** Latest app + foreground handler — listeners are attached once and must stay fresh. */
let latestApp: LifeMentorApp | null = null;
let latestArrival: (() => void) | null = null;

/**
 * Idempotent: safe to call on startup and again after sign-in. Returns the honest state —
 * the caller may surface it in settings ("FCM: token registered" / "FCM: …").
 */
export async function initFcm(
  app: LifeMentorApp,
  /** invoked when an FCM message arrives while the app is foreground — pull the queue now */
  onForegroundArrival: () => void,
): Promise<{ ok: boolean; reason?: string }> {
  latestApp = app;
  latestArrival = onForegroundArrival;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    if (!listenersReady) {
      listenersReady = true;
      // The registration event fires after each successful register() — post the token to
      // the server. Signed out → no access token yet → skipped, posted on next sign-in.
      await PushNotifications.addListener('registration', ({ value }) => {
        const current = latestApp;
        if (!current) return;
        void postToken(current, value).catch((error) => console.warn('[fcm] token post failed:', error));
      });
      await PushNotifications.addListener('registrationError', (e: { error: string }) => {
        console.warn('[fcm] registration failed:', e.error);
      });
      // Foreground arrival (and replay of a background message on app start): the server
      // already queued it — pull it through the local gate right away.
      await PushNotifications.addListener('pushNotificationReceived', () => {
        latestArrival?.();
      });
    }

    const state = await app.services.auth.state();
    const phase = state.authenticated ? 'authed' : 'anon';
    if (registeredPhase !== phase) {
      registeredPhase = phase;
      await PushNotifications.requestPermissions();
      // register() re-fires the registration event with the current FCM token.
      await PushNotifications.register();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function postToken(app: LifeMentorApp, token: string): Promise<void> {
  const access = await app.services.auth.accessToken();
  if (!access) return; // signed out — the token is per-user on the server; posted after sign-in
  const res = await fetch(`${SERVER_URL}/v1/notifications/push-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'fcm', token }),
  });
  if (!res.ok) console.warn(`[fcm] token registration failed: ${res.status}`);
}

/** Diagnostics for settings: is the FCM transport active on this device? */
export async function fcmStatus(app: LifeMentorApp): Promise<{ registered: boolean; reason?: string }> {
  const state = await app.services.auth.state();
  if (!state.authenticated) return { registered: false, reason: 'signed out' };
  const result = await initFcm(app, () => undefined);
  if (!result.ok) return { registered: false, reason: result.reason };
  return { registered: true };
}
