import { describe, expect, it } from 'vitest';
import { createTestServer, registerUser, testConfig, authHeader } from './helpers';

/**
 * Auth API (docs/08 §2; req. 56, 57).
 *
 * These tests drive the real Fastify app through `inject`, so routing, validation, rate limits,
 * JWT signing, scrypt hashing and SQL are all exercised exactly as in production.
 */

const PASSWORD = 'a-strong-passphrase';

describe('POST /v1/auth/register', () => {
  it('creates an account and returns a token pair', async () => {
    const server = await createTestServer();
    const result = await registerUser(server.app, { email: 'ada@example.com', display_name: 'Ada' });

    expect(result.user_id).toMatch(/^user_/);
    expect(result.email).toBe('ada@example.com');
    expect(result.access_token.split('.').length).toBe(3); // JWT
    expect(result.refresh_token.length).toBeGreaterThanOrEqual(32);
    expect(new Date(result.access_expires_at).getTime()).toBeGreaterThan(Date.now());

    // the password is never stored in the clear
    const row = await server.context.db.get<{ password_hash: string; password_salt: string }>(
      'SELECT password_hash, password_salt FROM users WHERE user_id = ?', [result.user_id],
    );
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_hash).not.toContain(PASSWORD);
    expect(row?.password_salt.length).toBe(32); // 16 bytes hex

    const audit = await server.context.audit.recent({ event: 'register' });
    expect(audit.length).toBe(1);
    expect(audit[0].detail).not.toContain(PASSWORD);

    await server.shutdown();
  });

  it('rejects a duplicate email with 409 and a weak password with 400', async () => {
    const server = await createTestServer();
    await registerUser(server.app, { email: 'ada@example.com' });

    const duplicate = await server.app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'ADA@example.com ', password: PASSWORD, device_id: 'device-2' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('conflict');

    const weak = await server.app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'bob@example.com', password: 'short', device_id: 'device-2' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('validation');

    const malformed = await server.app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: PASSWORD, device_id: 'device-2' },
    });
    expect(malformed.statusCode).toBe(400);

    await server.shutdown();
  });

  it('rate-limits auth endpoints', async () => {
    const server = await createTestServer({ config: testConfig({ RATE_LIMIT_AUTH: '3' }) });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await server.app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { email: `nobody${index}@example.com`, password: PASSWORD, device_id: 'device-x' },
        remoteAddress: '203.0.113.9',
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
    await server.shutdown();
  });
});

describe('POST /v1/auth/login', () => {
  it('authenticates with the right password and refuses the wrong one', async () => {
    const server = await createTestServer();
    const created = await registerUser(server.app, { email: 'ada@example.com' });

    const ok = await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD, device_id: 'device-2' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user_id).toBe(created.user_id);
    expect(ok.json().access_token).toBeTruthy();

    const wrong = await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: 'the-wrong-passphrase', device_id: 'device-2' },
    });
    expect(wrong.statusCode).toBe(401);

    // unknown account produces the same answer — no account enumeration
    const unknown = await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ghost@example.com', password: PASSWORD, device_id: 'device-2' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe(wrong.json().error);

    const failures = await server.context.audit.recent({ event: 'login_failed' });
    expect(failures.length).toBe(2);

    await server.shutdown();
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rotates the refresh token and rejects a replayed one', async () => {
    const server = await createTestServer();
    const created = await registerUser(server.app, { email: 'ada@example.com', device_id: 'device-a' });

    const rotated = await server.app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      payload: { refresh_token: created.refresh_token, device_id: 'device-a' },
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json();
    expect(next.refresh_token).not.toBe(created.refresh_token);
    expect(next.user_id).toBe(created.user_id);

    // the presented token is now revoked; replaying it kills the device's sessions
    const replay = await server.app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      payload: { refresh_token: created.refresh_token, device_id: 'device-a' },
    });
    expect(replay.statusCode).toBe(401);

    const afterReplay = await server.app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      payload: { refresh_token: next.refresh_token, device_id: 'device-a' },
    });
    expect(afterReplay.statusCode).toBe(401); // device sessions were revoked

    // a refresh token is bound to the device that received it
    const second = await registerUser(server.app, { email: 'bob@example.com', device_id: 'device-b' });
    const crossDevice = await server.app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      payload: { refresh_token: second.refresh_token, device_id: 'device-evil' },
    });
    expect(crossDevice.statusCode).toBe(401);

    // tokens at rest are hashes, never the value the client holds
    const stored = await server.context.db.all<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((row) => row.token_hash.length === 64)).toBe(true);
    expect(stored.some((row) => row.token_hash === next.refresh_token)).toBe(false);

    await server.shutdown();
  });

  it('logout revokes the refresh token', async () => {
    const server = await createTestServer();
    const created = await registerUser(server.app, { email: 'ada@example.com' });

    const out = await server.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refresh_token: created.refresh_token } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });

    const reuse = await server.app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      payload: { refresh_token: created.refresh_token, device_id: 'device-test' },
    });
    expect(reuse.statusCode).toBe(401);

    // logging out twice is harmless
    const again = await server.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refresh_token: created.refresh_token } });
    expect(again.statusCode).toBe(200);

    await server.shutdown();
  });
});

describe('protected routes', () => {
  it('require a valid access token', async () => {
    const server = await createTestServer();

    const anonymous = await server.app.inject({ method: 'GET', url: '/v1/sync/status' });
    expect(anonymous.statusCode).toBe(401);

    const garbage = await server.app.inject({ method: 'GET', url: '/v1/sync/status', headers: { authorization: 'Bearer not-a-jwt' } });
    expect(garbage.statusCode).toBe(401);

    const created = await registerUser(server.app, { email: 'ada@example.com' });
    const authorised = await server.app.inject({ method: 'GET', url: '/v1/sync/status', headers: authHeader(created.access_token) });
    expect(authorised.statusCode).toBe(200);

    await server.shutdown();
  });

  it('change password invalidates every session', async () => {
    const server = await createTestServer();
    const created = await registerUser(server.app, { email: 'ada@example.com' });

    const wrong = await server.app.inject({
      method: 'POST', url: '/v1/auth/password/change', headers: authHeader(created.access_token),
      payload: { current_password: 'not-my-password', new_password: 'another-strong-passphrase' },
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await server.app.inject({
      method: 'POST', url: '/v1/auth/password/change', headers: authHeader(created.access_token),
      payload: { current_password: PASSWORD, new_password: 'another-strong-passphrase' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().revokedSessions).toBeGreaterThanOrEqual(1);

    const oldLogin = await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD, device_id: 'device-a' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: 'another-strong-passphrase', device_id: 'device-a' },
    });
    expect(newLogin.statusCode).toBe(200);

    await server.shutdown();
  });

  it('lists and revokes devices', async () => {
    const server = await createTestServer();
    const first = await registerUser(server.app, { email: 'ada@example.com', device_id: 'device-a' });
    await server.app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD, device_id: 'device-b' },
    });

    const list = await server.app.inject({ method: 'GET', url: '/v1/devices', headers: authHeader(first.access_token, 'device-a') });
    expect(list.statusCode).toBe(200);
    const devices = list.json().devices as { device_id: string; current: boolean }[];
    expect(devices.map((d) => d.device_id).sort()).toEqual(['device-a', 'device-b']);
    expect(devices.find((d) => d.device_id === 'device-a')?.current).toBe(true);

    const revoke = await server.app.inject({ method: 'DELETE', url: '/v1/devices/device-b', headers: authHeader(first.access_token, 'device-a') });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedSessions).toBeGreaterThanOrEqual(1);

    const after = await server.app.inject({ method: 'GET', url: '/v1/devices', headers: authHeader(first.access_token, 'device-a') });
    expect((after.json().devices as unknown[]).length).toBe(1);

    await server.shutdown();
  });
});

describe('POST /v1/account/delete', () => {
  it('wipes everything the server holds and returns a receipt', async () => {
    const server = await createTestServer();
    const created = await registerUser(server.app, { email: 'ada@example.com', device_id: 'device-a' });

    // give the account some data on the server
    await server.app.inject({
      method: 'POST', url: '/v1/sync/push', headers: authHeader(created.access_token, 'device-a'),
      payload: {
        device_id: 'device-a',
        operations: [{
          operation_id: 'op-1', entity_type: 'goal', entity_id: 'goal_1', operation_type: 'create',
          base_version: 0, version: 1, payload: { id: 'goal_1', title: 'Private goal' }, updated_at: new Date().toISOString(),
        }],
      },
    });
    expect((await server.context.sync.status(created.user_id)).entities).toBe(1);

    const deleted = await server.app.inject({ method: 'POST', url: '/v1/account/delete', headers: authHeader(created.access_token) });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().receipt).toContain('deleted_');
    expect(deleted.json().purged_rows).toBeGreaterThan(0);

    // nothing is left
    expect(await server.context.users.findById(created.user_id)).toBeUndefined();
    expect((await server.context.sync.status(created.user_id)).entities).toBe(0);
    const feed = await server.context.db.all('SELECT * FROM sync_feed WHERE user_id = ?', [created.user_id]);
    expect(feed).toHaveLength(0);

    // the token no longer works
    const after = await server.app.inject({ method: 'GET', url: '/v1/sync/status', headers: authHeader(created.access_token) });
    expect(after.statusCode).toBe(401);

    // and a new account can reuse the email
    const again = await registerUser(server.app, { email: 'ada@example.com' });
    expect(again.user_id).not.toBe(created.user_id);

    await server.shutdown();
  });
});

describe('health', () => {
  it('reports the server state without secrets', async () => {
    const server = await createTestServer();
    const health = await server.app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    expect(body.ok).toBe(true);
    expect(body.integrity.ok).toBe(true);
    expect(body.ai).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('test-secret-value');

    const version = await server.app.inject({ method: 'GET', url: '/v1/version' });
    expect(version.json().endpoints).toContain('POST /v1/sync/push');

    await server.shutdown();
  });
});
