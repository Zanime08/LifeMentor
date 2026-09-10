import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { ServerConfig } from '../src/config';
import { FcmClient } from '../src/services/fcm';

/** A throwaway RSA key pair standing in for the Firebase service account (test-only). */
function fakeServiceAccount() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    projectId: 'lifementor-test',
    clientEmail: 'fcm-test@lifementor-test.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://fcm.googleapis.com/v1/projects/lifementor-test/messages:send';

interface HttpCapture {
  url: string;
  calls: number;
  lastInit?: RequestInit;
}

/** Mock fetch that answers the OAuth token endpoint and the FCM send endpoint. */
function mockHttp(overrides: {
  tokenStatus?: number;
  sendStatus?: number;
  sendBody?: Record<string, unknown>;
} = {}) {
  const captures: Record<string, HttpCapture> = {};
  const capture = (url: string, init?: RequestInit): HttpCapture => {
    const entry = (captures[url] ??= { url, calls: 0 });
    entry.calls += 1;
    entry.lastInit = init;
    return entry;
  };

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(TOKEN_URL)) {
      capture(TOKEN_URL, init);
      if (overrides.tokenStatus && overrides.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: overrides.tokenStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ access_token: 'fcm-access-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith(SEND_URL)) {
      capture(SEND_URL, init);
      const status = overrides.sendStatus ?? 201;
      return new Response(JSON.stringify(overrides.sendBody ?? { name: 'projects/lifementor-test/messages/1' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in fcm test: ${url}`);
  }) as typeof fetch;

  return { impl, captures };
}

function testConfig(fcm: { projectId: string; clientEmail: string; privateKey: string } | null): ServerConfig {
  const config = loadConfig();
  return {
    ...config,
    env: 'test',
    databaseInMemory: true,
    jwtSecret: 'test-secret-0123456789',
    push: { ...config.push, fcm },
  } as ServerConfig;
}

describe('FcmClient (unit)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mints a valid RS256 JWT with the messaging scope', () => {
    const sa = fakeServiceAccount();
    const client = new FcmClient({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey });

    const jwt = client.mintJwt(1_700_000_000);
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    expect(headerB64).toBeDefined();

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: sa.clientEmail,
      aud: TOKEN_URL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    expect(verifier.verify(sa.publicKeyPem, Buffer.from(signatureB64, 'base64url'))).toBe(true);
  });

  it('exchanges the JWT for an access token and caches it across sends', async () => {
    const sa = fakeServiceAccount();
    const http = mockHttp();
    const client = new FcmClient({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }, http.impl);

    const first = await client.send('device-token-1', { title: 'a', data: { id: 'n1' }, urgent: false });
    expect(first.ok).toBe(true);
    expect(http.captures[TOKEN_URL].calls).toBe(1);

    const second = await client.send('device-token-2', { title: 'b', urgent: false });
    expect(second.ok).toBe(true);
    expect(http.captures[TOKEN_URL].calls).toBe(1); // cached — no second exchange
    expect(http.captures[SEND_URL].calls).toBe(2);
  });

  it('sends the v1 message shape: urgent → notification payload, data-only otherwise', async () => {
    const sa = fakeServiceAccount();
    const http = mockHttp();
    const client = new FcmClient({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }, http.impl);

    await client.send('device-token-1', { title: 'Заголовок', body: 'Текст', data: { id: 'n1', type: 'important_news' }, urgent: true });
    let body = JSON.parse(String(http.captures[SEND_URL].lastInit?.body)) as { message: Record<string, unknown> };
    expect(body.message).toMatchObject({
      token: 'device-token-1',
      notification: { title: 'Заголовок', body: 'Текст' },
      data: { id: 'n1', type: 'important_news' },
      android: { priority: 'high', ttl: '24h' },
    });
    expect(http.captures[SEND_URL].lastInit?.headers).toMatchObject({ authorization: 'Bearer fcm-access-token' });

    await client.send('device-token-1', { title: 'Тихое', data: { id: 'n2' }, urgent: false });
    body = JSON.parse(String(http.captures[SEND_URL].lastInit?.body)) as { message: Record<string, unknown> };
    expect(body.message.notification).toBeUndefined(); // data-only: the app's gate decides
    expect(body.message.android).toMatchObject({ priority: 'normal' });
  });

  it('reports a dead token (404) as gone', async () => {
    const sa = fakeServiceAccount();
    const http = mockHttp({ sendStatus: 404, sendBody: { error: { message: 'Requested entity was not found.' } } });
    const client = new FcmClient({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }, http.impl);

    const result = await client.send('dead-token', { title: 'x', urgent: false });
    expect(result.ok).toBe(false);
    expect(result.gone).toBe(true);
    expect(result.status).toBe(404);
  });

  it('treats 401 as a stale access token and re-exchanges on the next send', async () => {
    const sa = fakeServiceAccount();
    // mutable send status: 201 → 401 → 201 across three sends
    let sendStatus = 201;
    const saCreds = { projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey };
    const captures: Record<string, number> = {};
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(TOKEN_URL)) {
        captures.token = (captures.token ?? 0) + 1;
        return new Response(JSON.stringify({ access_token: `tok-${captures.token}`, expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith(SEND_URL)) {
        captures.send = (captures.send ?? 0) + 1;
        return new Response(JSON.stringify({ name: 'm' }), { status: sendStatus, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const client = new FcmClient(saCreds, impl);

    expect((await client.send('t', { title: 'a', urgent: false })).ok).toBe(true);
    expect(captures.token).toBe(1);

    sendStatus = 401;
    const failed = await client.send('t', { title: 'a', urgent: false });
    expect(failed.ok).toBe(false);
    expect(failed.gone).toBe(false);

    // the 401 invalidated the cached token → the next send exchanges a fresh one
    sendStatus = 201;
    expect((await client.send('t', { title: 'a', urgent: false })).ok).toBe(true);
    expect(captures.token).toBe(2);
    expect(captures.send).toBe(3);
  });

  it('a misconfigured client (no credentials) never calls the network', async () => {
    const client = new FcmClient(null);
    expect(client.enabled).toBe(false);
    const result = await client.send('t', { title: 'a', urgent: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/);
  });
});

describe('FCM delivery (PushService integration)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('urgent fcm push: sent + marked delivered (no double poll); non-urgent: sent, still pollable', async () => {
    const sa = fakeServiceAccount();
    const http = mockHttp();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = http.impl;

    try {
      const { app, shutdown, context } = await buildServer(testConfig({
        projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey,
      }));
      try {
        const registered = await app.inject({
          method: 'POST', url: '/v1/auth/register',
          payload: { email: 'fcm1@test.dev', password: 'supersecret1', device_id: 'android-1' },
        });
        expect(registered.statusCode).toBe(201);
        const token = (registered.json() as { access_token: string }).access_token;
        const auth = { authorization: `Bearer ${token}` };
        const userId = (await context.tokens.verifyAccess(token)).userId;

        await app.inject({
          method: 'POST', url: '/v1/notifications/push-token', headers: auth,
          payload: { kind: 'fcm', token: 'fcm-device-token-000000000000000001' },
        });

        // Non-urgent: data-only FCM message → sent, but stays in the queue for the app's gate.
        const quiet = await context.push.notify(userId, {
          type: 'mentor_message', title: 'Привет', body: 'Тихое сообщение', data: { hello: 'world' },
        });
        expect(quiet.push).toBe('sent');
        let pending = await context.push.pending(userId, 50);
        expect(pending).toHaveLength(1);
        expect(pending[0].push_error).toBeNull();

        let message = JSON.parse(String(http.captures[SEND_URL].lastInit?.body)) as { message: Record<string, unknown> };
        expect(message.message).toMatchObject({ token: 'fcm-device-token-000000000000000001' });
        expect(message.message.notification).toBeUndefined();
        expect(message.message.data).toMatchObject({ id: pending[0].id, type: 'mentor_message', hello: 'world' });

        // Urgent: visible notification payload → sent AND marked delivered (OS shows it).
        const urgent = await context.push.notify(userId, {
          type: 'important_news', title: 'Срочно', body: 'Проверьте', url: 'https://example.com/u1', urgent: true,
        });
        expect(urgent.push).toBe('sent');
        pending = await context.push.pending(userId, 50);
        // only the quiet one remains — the urgent one was consumed by the OS
        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe(quiet.id);

        message = JSON.parse(String(http.captures[SEND_URL].lastInit?.body)) as { message: Record<string, unknown> };
        expect(message.message.notification).toMatchObject({ title: 'Срочно', body: 'Проверьте' });
        expect(message.message.data).toMatchObject({ url: 'https://example.com/u1' });

        await shutdown();
      } finally {
        await shutdown().catch(() => undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('dead fcm token (404): subscription dropped, notification left for polling', async () => {
    const sa = fakeServiceAccount();
    const http = mockHttp({ sendStatus: 404, sendBody: { error: { message: 'Requested entity was not found.' } } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = http.impl;

    try {
      const { app, shutdown, context } = await buildServer(testConfig({
        projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey,
      }));
      try {
        const registered = await app.inject({
          method: 'POST', url: '/v1/auth/register',
          payload: { email: 'fcm2@test.dev', password: 'supersecret1', device_id: 'android-2' },
        });
        const token = (registered.json() as { access_token: string }).access_token;
        const auth = { authorization: `Bearer ${token}` };
        const userId = (await context.tokens.verifyAccess(token)).userId;

        await app.inject({
          method: 'POST', url: '/v1/notifications/push-token', headers: auth,
          payload: { kind: 'fcm', token: 'fcm-dead-token-0000000000000000001' },
        });
        expect(await context.push.countSubscriptions(userId)).toBe(1);

        const result = await context.push.notify(userId, { type: 'mentor_message', title: 'x', urgent: false });
        expect(result.push).toBe('failed');
        expect(result.error).toMatch(/token expired/i);
        // the dead token was removed; the notification is still pollable
        expect(await context.push.countSubscriptions(userId)).toBe(0);
        const pending = await context.push.pending(userId, 50);
        expect(pending).toHaveLength(1);
        expect(pending[0].push_error).toMatch(/token expired/i);

        await shutdown();
      } finally {
        await shutdown().catch(() => undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('server without firebase config: fcm subscriptions ride the polling path (honest error)', async () => {
    const { app, shutdown } = await buildServer(testConfig(null));
    try {
      const registered = await app.inject({
        method: 'POST', url: '/v1/auth/register',
        payload: { email: 'fcm3@test.dev', password: 'supersecret1', device_id: 'android-3' },
      });
      const token = (registered.json() as { access_token: string }).access_token;
      const auth = { authorization: `Bearer ${token}` };
      await app.inject({
        method: 'POST', url: '/v1/notifications/push-token', headers: auth,
        payload: { kind: 'fcm', token: 'fcm-device-token-000000000000000002' },
      });
      const test = await app.inject({ method: 'POST', url: '/v1/notifications/test', headers: auth });
      const body = test.json() as { push: string; error?: string };
      expect(body.push).toBe('failed');
      expect(body.error).toMatch(/fcm transport not enabled/);
      const pending = (await app.inject({ method: 'GET', url: '/v1/notifications/pending', headers: auth })).json() as { notifications: unknown[] };
      expect(pending.notifications).toHaveLength(1);

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });
});
