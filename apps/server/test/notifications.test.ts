import { afterEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { buildServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { ServerConfig } from '../src/config';

function testConfig(): ServerConfig {
  const config = loadConfig();
  return { ...config, env: 'test', databaseInMemory: true, jwtSecret: 'test-secret-0123456789' } as ServerConfig;
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/subscriptions/abcdef-1234',
  keys: {
    p256dh: 'BMibmzDQvR0oXzs0CwF5Kc4GqJ7hLmNpRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqR',
    auth: 'secretAuthKey0123456789',
  },
};

interface Captured { endpoint?: string; payload?: Record<string, unknown>; options?: unknown }

async function register(app: { inject: (req: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): unknown }> }, email: string): Promise<string> {
  const registered = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email, password: 'supersecret1', device_id: 'device-push' },
  });
  expect(registered.statusCode).toBe(201);
  return (registered.json() as { access_token: string }).access_token;
}

describe('push notifications (server)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('vapid key, subscription upsert, web push delivery, polling + delivered', async () => {
    const captured: Captured[] = [];
    const spy = vi.spyOn(webpush, 'sendNotification').mockImplementation((async (sub: { endpoint: string }, payload: string, options?: unknown) => {
      captured.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown>, options });
    }) as never);

    const { app, shutdown, context } = await buildServer(testConfig());
    try {
      const token = await register(app, 'push1@test.dev');
      const auth = { authorization: `Bearer ${token}` };

      // VAPID public key is served (base64url of the 65-byte uncompressed point → 87 chars).
      const keyRes = await app.inject({ method: 'GET', url: '/v1/notifications/push/vapid-public-key', headers: auth });
      expect(keyRes.statusCode).toBe(200);
      const { publicKey } = keyRes.json() as { publicKey: string };
      expect(publicKey.length).toBe(87);
      expect(context.push.vapidPublicKey).toBe(publicKey);

      // Unauthenticated requests are rejected.
      const unauth = await app.inject({ method: 'GET', url: '/v1/notifications/pending' });
      expect(unauth.statusCode).toBe(401);

      // Subscribe — and re-subscribing the same endpoint does not duplicate.
      const subRes = await app.inject({ method: 'POST', url: '/v1/notifications/push-token', headers: auth, payload: { kind: 'web', subscription: SUBSCRIPTION } });
      expect(subRes.statusCode).toBe(200);
      expect(subRes.json()).toMatchObject({ ok: true, created: true, count: 1 });
      const subAgain = await app.inject({ method: 'POST', url: '/v1/notifications/push-token', headers: auth, payload: { kind: 'web', subscription: SUBSCRIPTION } });
      expect(subAgain.json()).toMatchObject({ ok: true, created: false, count: 1 });

      // Test push: delivered via Web Push, payload carries title/body/data.
      const testRes = await app.inject({ method: 'POST', url: '/v1/notifications/test', headers: auth });
      expect(testRes.statusCode).toBe(200);
      const testBody = testRes.json() as { ok: boolean; push: string; id: string };
      expect(testBody.ok).toBe(true);
      expect(testBody.push).toBe('sent');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(captured[0].endpoint).toBe(SUBSCRIPTION.endpoint);
      expect(captured[0].payload).toMatchObject({ title: 'LifeMentor', body: 'Тестовое уведомление: доставка работает.' });
      expect(captured[0].options).toMatchObject({ urgency: 'normal' });

      // It remains in the polling queue until the client confirms it.
      const pending = await app.inject({ method: 'GET', url: '/v1/notifications/pending', headers: auth });
      const pendingBody = pending.json() as { notifications: { id: string; type: string }[] };
      expect(pendingBody.notifications).toHaveLength(1);
      expect(pendingBody.notifications[0].id).toBe(testBody.id);

      const delivered = await app.inject({ method: 'POST', url: `/v1/notifications/${testBody.id}/delivered`, headers: auth });
      expect((delivered.json() as { ok: boolean }).ok).toBe(true);
      const deliveredAgain = await app.inject({ method: 'POST', url: `/v1/notifications/${testBody.id}/delivered`, headers: auth });
      expect((deliveredAgain.json() as { ok: boolean }).ok).toBe(false);

      const pendingAfter = await app.inject({ method: 'GET', url: '/v1/notifications/pending', headers: auth });
      expect((pendingAfter.json() as { notifications: unknown[] }).notifications).toHaveLength(0);

      // Unsubscribe.
      const del = await app.inject({ method: 'DELETE', url: '/v1/notifications/push-token', headers: auth, payload: { endpoint: SUBSCRIPTION.endpoint } });
      expect(del.json()).toMatchObject({ ok: true, removed: 1 });
      expect(await context.push.countSubscriptions(await userIdOf(context, token))).toBe(0);

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });

  it('failed push stays in the queue (polling fallback); 410 removes the subscription; fcm stays pending', async () => {
    const { app, shutdown, context } = await buildServer(testConfig());
    try {
      const token = await register(app, 'push2@test.dev');
      const auth = { authorization: `Bearer ${token}` };
      await app.inject({ method: 'POST', url: '/v1/notifications/push-token', headers: auth, payload: { kind: 'web', subscription: SUBSCRIPTION } });

      // Transport error (500): subscription kept, notification left in the queue for polling.
      vi.spyOn(webpush, 'sendNotification').mockImplementation((async () => {
        const error = new Error('InternalServerError') as Error & { statusCode?: number };
        error.statusCode = 500;
        throw error;
      }) as never);

      const failed = await app.inject({ method: 'POST', url: '/v1/notifications/test', headers: auth });
      expect((failed.json() as { push: string; error?: string }).push).toBe('failed');
      const pendingAfterFail = (await app.inject({ method: 'GET', url: '/v1/notifications/pending', headers: auth })).json() as { notifications: { push_error: string | null }[] };
      expect(pendingAfterFail.notifications).toHaveLength(1);
      expect(pendingAfterFail.notifications[0].push_error).toContain('InternalServerError');
      // The subscription is still there with the error recorded.
      expect(await context.push.countSubscriptions(await userIdOf(context, token))).toBe(1);

      // 410 Gone: expired subscription is removed, the notification is still pollable.
      vi.spyOn(webpush, 'sendNotification').mockImplementation((async () => {
        const error = new Error('Gone') as Error & { statusCode?: number };
        error.statusCode = 410;
        throw error;
      }) as never);
      const gone = await app.inject({ method: 'POST', url: '/v1/notifications/test', headers: auth });
      expect((gone.json() as { push: string }).push).toBe('failed');
      expect(await context.push.countSubscriptions(await userIdOf(context, token))).toBe(0);

      // FCM token: accepted and stored, but no transport yet — honest error, polling delivers.
      const fcm = await app.inject({ method: 'POST', url: '/v1/notifications/push-token', headers: auth, payload: { kind: 'fcm', token: 'fcm-token-abcdefghijklmnop' } });
      expect(fcm.json()).toMatchObject({ ok: true, count: 1 });
      const fcmTest = await app.inject({ method: 'POST', url: '/v1/notifications/test', headers: auth });
      const fcmBody = fcmTest.json() as { push: string; error?: string };
      expect(fcmBody.push).toBe('failed');
      expect(fcmBody.error).toMatch(/fcm transport not enabled/i);
      // All three test notifications are still pollable (N1: 500, N2: 410, N3: fcm).
      const pendingFcm = (await app.inject({ method: 'GET', url: '/v1/notifications/pending', headers: auth })).json() as { notifications: unknown[] };
      expect(pendingFcm.notifications.length).toBe(3);

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });

  it('urgent news pushes respect the daily cap and are deduped by URL', async () => {
    const { app, shutdown, context } = await buildServer(testConfig());
    try {
      const token = await register(app, 'push3@test.dev');
      const userId = await userIdOf(context, token);

      const items = [
        { url: 'https://example.com/n1', title: 'Срочно: что-то случилось' },
        { url: 'https://example.com/n2', title: 'Вторая срочная новость' },
        { url: 'https://example.com/n3', title: 'Третья срочная новость' },
        { url: 'https://example.com/n4', title: 'Четвёртая срочная новость' },
      ];
      vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as never);
      await context.push.addSubscription(userId, 'device-push', { kind: 'web', endpoint: SUBSCRIPTION.endpoint, p256dh: SUBSCRIPTION.keys.p256dh, authSecret: SUBSCRIPTION.keys.auth });

      const sent = await context.push.notifyUrgentNews(userId, items);
      expect(sent).toBe(3); // daily cap = 3

      // Same URL again — deduped, nothing new.
      const again = await context.push.notifyUrgentNews(userId, [items[0]]);
      expect(again).toBe(0);

      const pending = await context.push.pending(userId, 50);
      expect(pending).toHaveLength(3);
      expect(pending.every((n) => n.type === 'important_news' && n.urgent === 1)).toBe(true);

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });

  it('news poller → push: new urgent items notify subscribed users (integration)', async () => {
    const originalFetch = globalThis.fetch;
    const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title>Breaking: major cyberattack on power grid</title><link>https://example.com/cyber</link><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate><description>Grid operators respond.</description></item>
<item><title>Calm ordinary news</title><link>https://example.com/calm</link><pubDate>Mon, 07 Sep 2026 09:00:00 GMT</pubDate><description>A quiet day, no incidents reported.</description></item>
</channel></rss>`;
    const captured: Captured[] = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation((async (sub: { endpoint: string }, payload: string, options?: unknown) => {
      captured.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown>, options });
    }) as never);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('example.com')) return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      return originalFetch(input as RequestInfo);
    }) as typeof fetch;

    try {
      const { app, shutdown, context } = await buildServer(testConfig());
      try {
        const token = await register(app, 'push4@test.dev');
        const userId = await userIdOf(context, token);
        await context.push.addSubscription(userId, 'device-push', { kind: 'web', endpoint: SUBSCRIPTION.endpoint, p256dh: SUBSCRIPTION.keys.p256dh, authSecret: SUBSCRIPTION.keys.auth });

        await context.news.ensureDefaultSources();
        await context.db.run('UPDATE news_sources SET enabled = 0');
        await context.db.run(
          "INSERT INTO news_sources (id, name, url, category, kind, enabled, created_at) VALUES ('feed-test', 'Test Feed', 'https://example.com/feed.xml', 'world', 'rss', 1, ?)",
          [new Date().toISOString()],
        );

        const result = await context.news.refresh();
        expect(result.added).toBe(2);

        // Exactly one push: the urgent item, with high urgency and the source URL.
        expect(captured).toHaveLength(1);
        expect(captured[0].payload).toMatchObject({ title: 'Срочная новость', url: 'https://example.com/cyber' });
        expect(String(captured[0].payload?.body)).toContain('cyberattack');
        expect(captured[0].options).toMatchObject({ urgency: 'high' });

        const pending = await context.push.pending(userId, 50);
        expect(pending).toHaveLength(1);
        expect(pending[0].type).toBe('important_news');

        // Re-fetch: no new items, no new pushes.
        await context.news.refresh();
        expect(captured).toHaveLength(1);

        await shutdown();
      } finally {
        await shutdown().catch(() => undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Resolve the user id from a fresh access token (the tests only hold the token). */
async function userIdOf(context: { tokens: { verifyAccess(token: string): Promise<{ userId: string }> } }, token: string): Promise<string> {
  const claims = await context.tokens.verifyAccess(token);
  return claims.userId;
}
