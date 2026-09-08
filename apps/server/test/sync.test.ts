import { describe, expect, it } from 'vitest';
import type { PushOperation } from '@lifementor/core';
import { authHeader, createTestServer, registerUser } from './helpers';

/**
 * Sync API (docs/04 §5, docs/08 §1) — the server side of the protocol the client's
 * `SyncEngine` + `HttpSyncTransport` speak.
 */

function operation(overrides: Partial<PushOperation> = {}): PushOperation {
  return {
    operation_id: `op_${Math.random().toString(36).slice(2, 10)}`,
    entity_type: 'task',
    entity_id: 'task_1',
    operation_type: 'create',
    base_version: 0,
    version: 1,
    payload: { id: 'task_1', title: 'Write the report', status: 'todo', version: 1, deleted: 0 },
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function push(server: Awaited<ReturnType<typeof createTestServer>>, token: string, deviceId: string, operations: PushOperation[]) {
  const response = await server.app.inject({
    method: 'POST', url: '/v1/sync/push', headers: authHeader(token, deviceId),
    payload: { device_id: deviceId, operations },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { results: { operation_id: string; status: string; server_version?: number; remote_payload?: Record<string, unknown>; error?: string }[] };
}

async function pull(server: Awaited<ReturnType<typeof createTestServer>>, token: string, deviceId: string, since?: string | null, limit = 200) {
  const params = new URLSearchParams({ limit: String(limit), device_id: deviceId });
  if (since) params.set('since', since);
  const response = await server.app.inject({ method: 'GET', url: `/v1/sync/pull?${params}`, headers: authHeader(token, deviceId) });
  expect(response.statusCode).toBe(200);
  return response.json() as { changes: { entity_type: string; entity_id: string; version: number; base_version: number; payload: Record<string, unknown>; deleted: boolean; origin_device: string | null; seq: string }[]; cursor: string };
}

describe('POST /v1/sync/push', () => {
  it('stores new entities and acknowledges each operation', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });

    const acks = await push(server, user.access_token, 'device-a', [
      operation({ entity_type: 'goal', entity_id: 'goal_1', payload: { id: 'goal_1', title: 'Ship it', version: 1, deleted: 0 } }),
      operation({ operation_id: 'op-2', entity_id: 'task_1' }),
    ]);

    expect(acks.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(acks.results[0].server_version).toBe(1);

    const stored = await server.context.sync.entity(user.user_id, 'goal', 'goal_1');
    expect(stored?.payload.title).toBe('Ship it');
    expect(stored?.version).toBe(1);
    expect((await server.context.sync.status(user.user_id)).entities).toBe(2);

    await server.shutdown();
  });

  it('fast-forwards when the client built on the current version', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });
    await push(server, user.access_token, 'device-a', [operation()]);

    const updated = await push(server, user.access_token, 'device-a', [
      operation({ operation_type: 'update', base_version: 1, version: 2, payload: { id: 'task_1', title: 'Write the final report', version: 2, deleted: 0 } }),
    ]);
    expect(updated.results[0].status).toBe('applied');
    expect(updated.results[0].server_version).toBe(2);

    const stored = await server.context.sync.entity(user.user_id, 'task', 'task_1');
    expect(stored?.payload.title).toBe('Write the final report');

    await server.shutdown();
  });

  it('answers a stale push with a conflict and the current payload', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });
    await push(server, user.access_token, 'device-a', [operation()]);

    // device A advances to v2 …
    await push(server, user.access_token, 'device-a', [
      operation({ operation_type: 'update', base_version: 1, version: 2, payload: { id: 'task_1', title: 'From desktop', version: 2, deleted: 0 } }),
    ]);

    // … device B still edits v1
    const stale = await push(server, user.access_token, 'device-b', [
      operation({ operation_type: 'update', base_version: 1, version: 2, payload: { id: 'task_1', title: 'From phone', version: 2, deleted: 0 } }),
    ]);

    expect(stale.results[0].status).toBe('conflict');
    expect(stale.results[0].server_version).toBe(2);
    expect(stale.results[0].remote_payload?.title).toBe('From desktop');

    // the server did not merge anything itself — the winner is still the first writer
    const stored = await server.context.sync.entity(user.user_id, 'task', 'task_1');
    expect(stored?.payload.title).toBe('From desktop');
    expect(stored?.version).toBe(2);

    const conflicts = await server.context.audit.recent({ event: 'sync_conflict' });
    expect(conflicts.length).toBe(1);

    await server.shutdown();
  });

  it('records deletions so other devices can apply them', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });
    await push(server, user.access_token, 'device-a', [operation()]);

    const deleted = await push(server, user.access_token, 'device-a', [
      operation({ operation_type: 'delete', base_version: 1, version: 2, payload: { id: 'task_1', title: 'Write the report', version: 1, deleted: 0 } }),
    ]);
    expect(deleted.results[0].status).toBe('applied');

    const stored = await server.context.sync.entity(user.user_id, 'task', 'task_1');
    expect(stored?.deleted).toBe(true);

    const page = await pull(server, user.access_token, 'device-b');
    const change = page.changes.find((c) => c.entity_id === 'task_1' && c.deleted);
    expect(change?.deleted).toBe(true);
    expect(change?.payload.deleted).toBe(1); // the payload says so too, for the client's merge rules
    expect((await server.context.sync.status(user.user_id)).deletedEntities).toBe(1);

    await server.shutdown();
  });

  it('rejects malformed operations without failing the whole batch', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });

    const acks = await push(server, user.access_token, 'device-a', [
      operation({ entity_type: 'goal', entity_id: 'goal_ok' }),
      operation({ entity_type: 'DROP TABLE users', entity_id: 'bad_type' }),
      operation({ entity_id: '', entity_type: 'task' }),
      operation({ version: 0, entity_id: 'bad_version' }),
      operation({ entity_id: 'huge', payload: { blob: 'x'.repeat(600 * 1024) } }),
    ]);

    expect(acks.results[0].status).toBe('applied');
    expect(acks.results.slice(1).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(acks.results[1].error).toMatch(/entity_type/);
    expect(acks.results[4].error).toMatch(/too large/);

    // the database survived untouched
    const integrity = await server.context.db.integrityCheck();
    expect(integrity.ok).toBe(true);
    expect((await server.context.sync.status(user.user_id)).entities).toBe(1);

    await server.shutdown();
  });

  it('refuses an oversized batch and unauthenticated calls', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });

    const tooMany = await server.app.inject({
      method: 'POST', url: '/v1/sync/push', headers: authHeader(user.access_token),
      payload: { device_id: 'device-a', operations: Array.from({ length: 501 }, (_, i) => operation({ entity_id: `task_${i}` })) },
    });
    expect(tooMany.statusCode).toBe(400);

    const anonymous = await server.app.inject({
      method: 'POST', url: '/v1/sync/push',
      payload: { device_id: 'device-a', operations: [operation()] },
    });
    expect(anonymous.statusCode).toBe(401);

    await server.shutdown();
  });
});

describe('GET /v1/sync/pull', () => {
  it('returns changes from other devices and never echoes the caller\'s own', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });

    await push(server, user.access_token, 'device-a', [operation({ entity_id: 'task_a', payload: { id: 'task_a', title: 'From A', version: 1, deleted: 0 } })]);
    await push(server, user.access_token, 'device-b', [operation({ entity_id: 'task_b', payload: { id: 'task_b', title: 'From B', version: 1, deleted: 0 } })]);

    const forB = await pull(server, user.access_token, 'device-b');
    expect(forB.changes.map((c) => c.entity_id)).toEqual(['task_a']);
    expect(forB.changes[0].origin_device).toBe('device-a');
    expect(forB.changes[0].payload.title).toBe('From A');

    const forA = await pull(server, user.access_token, 'device-a');
    expect(forA.changes.map((c) => c.entity_id)).toEqual(['task_b']);

    await server.shutdown();
  });

  it('advances the cursor incrementally and keeps it moving when nothing is new', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });

    await push(server, user.access_token, 'device-a', [
      operation({ entity_id: 'task_1' }),
      operation({ entity_id: 'task_2', operation_type: 'create' }),
      operation({ entity_id: 'task_3', operation_type: 'create' }),
    ]);

    const firstPage = await pull(server, user.access_token, 'device-b', null, 2);
    expect(firstPage.changes.map((c) => c.entity_id)).toEqual(['task_1', 'task_2']);
    const cursor = firstPage.cursor;
    expect(Number(cursor)).toBeGreaterThan(0);

    const secondPage = await pull(server, user.access_token, 'device-b', cursor, 2);
    expect(secondPage.changes.map((c) => c.entity_id)).toEqual(['task_3']);

    const idle = await pull(server, user.access_token, 'device-b', secondPage.cursor);
    expect(idle.changes).toHaveLength(0);
    // the cursor still moves to the head so clients never rescan the feed
    expect(Number(idle.cursor)).toBeGreaterThanOrEqual(Number(secondPage.cursor));

    await server.shutdown();
  });

  it('keeps users strictly separated', async () => {
    const server = await createTestServer();
    const alice = await registerUser(server.app, { email: 'alice@example.com', device_id: 'device-a' });
    const bob = await registerUser(server.app, { email: 'bob@example.com', device_id: 'device-b' });

    await push(server, alice.access_token, 'device-a', [
      operation({ entity_type: 'memory', entity_id: 'memory_1', payload: { id: 'memory_1', content: 'Alice private memory', version: 1, deleted: 0 } }),
    ]);
    await push(server, bob.access_token, 'device-b', [
      operation({ entity_type: 'memory', entity_id: 'memory_2', payload: { id: 'memory_2', content: 'Bob private memory', version: 1, deleted: 0 } }),
    ]);

    const bobSees = await pull(server, bob.access_token, 'device-other');
    expect(bobSees.changes.map((c) => c.entity_id)).toEqual(['memory_2']);
    expect(JSON.stringify(bobSees)).not.toContain('Alice private memory');

    expect((await server.context.sync.status(alice.user_id)).entities).toBe(1);
    expect((await server.context.sync.status(bob.user_id)).entities).toBe(1);

    // even a crafted entity id cannot cross the boundary
    expect(await server.context.sync.entity(bob.user_id, 'memory', 'memory_1')).toBeNull();

    await server.shutdown();
  });

  it('reports status and tracks devices', async () => {
    const server = await createTestServer();
    const user = await registerUser(server.app, { device_id: 'device-a' });
    await push(server, user.access_token, 'device-a', [operation()]);
    await push(server, user.access_token, 'device-b', [operation({ entity_id: 'task_2' })]);

    const status = await server.app.inject({ method: 'GET', url: '/v1/sync/status', headers: authHeader(user.access_token, 'device-b') });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.entities).toBe(2);
    expect(body.feedLength).toBe(2);
    expect(body.devices).toBe(2);
    expect(body.deviceId).toBe('device-b');

    const devices = await server.app.inject({ method: 'GET', url: '/v1/devices', headers: authHeader(user.access_token, 'device-b') });
    expect((devices.json().devices as { device_id: string }[]).map((d) => d.device_id).sort()).toEqual(['device-a', 'device-b']);

    await server.shutdown();
  });
});
