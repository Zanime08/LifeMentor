import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, nowIso } from '@lifementor/core';
import type { PushOperation } from '@lifementor/core';
import type { ServerContext } from '../context';
import { clientIp, requestDeviceId } from '../http/auth';

/**
 * Sync endpoints (docs/04 §5, docs/08 §1).
 *
 * The wire contract is exactly what `HttpSyncTransport` sends:
 *   POST /v1/sync/push  { device_id, operations[] } → { results: PushAck[] }
 *   GET  /v1/sync/pull?since=&limit=&device_id=     → { changes: RemoteChange[], cursor }
 *
 * Everything is scoped to `request.userId`, which comes from the verified access token — a body
 * field claiming another user is ignored by construction.
 */

/**
 * The envelope is validated here; each operation is validated in `SyncStore` so that one malformed
 * row produces a `rejected` ack instead of failing a batch of otherwise valid changes.
 */
const pushSchema = z.object({
  device_id: z.string().max(96).optional(),
  operations: z.array(z.record(z.unknown())).max(500),
});

const pullQuerySchema = z.object({
  since: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  device_id: z.string().max(96).optional(),
});

export async function registerSyncRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const limit = { config: { rateLimit: { max: context.config.rateLimit.sync, timeWindow: context.config.rateLimit.windowMs } } };

  app.post('/v1/sync/push', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const body = parse(pushSchema, request.body);
    const deviceId = requestDeviceId(request) || body.device_id || '';
    const operations = body.operations.map((operation) => ({
      ...(operation as object as PushOperation),
      updated_at: typeof operation.updated_at === 'string' ? operation.updated_at : nowIso(),
    }));
    const results = await context.sync.push(request.userId, deviceId, operations, clientIp(request));
    return reply.send({ results, accepted: results.length });
  });

  app.get('/v1/sync/pull', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const query = parse(pullQuerySchema, request.query);
    const deviceId = requestDeviceId(request) || query.device_id || '';
    const page = await context.sync.pull(request.userId, query.since ?? null, query.limit ?? 200, deviceId);
    await context.audit.record({
      event: 'sync_pull', userId: request.userId, deviceId, ip: clientIp(request),
      detail: { changes: page.changes.length, cursor: page.cursor },
    });
    return reply.send(page);
  });

  app.get('/v1/sync/status', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const status = await context.sync.status(request.userId);
    return reply.send({ ...status, deviceId: requestDeviceId(request) });
  });

  /** Devices registered to this account, with their live sessions. */
  app.get('/v1/devices', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const devices = await context.db.all<{ device_id: string; name: string | null; platform: string | null; registered_at: string; last_seen_at: string }>(
      'SELECT device_id, name, platform, registered_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC',
      [request.userId],
    );
    const sessions = await context.tokens.activeSessions(request.userId);
    const activeDevices = new Set(sessions.map((s) => s.device_id));
    return reply.send({
      devices: devices.map((device) => ({ ...device, current: device.device_id === requestDeviceId(request), sessionActive: activeDevices.has(device.device_id) })),
      sessions,
    });
  });

  /** Revoke one device: its refresh tokens die, so it can no longer sync or call the AI. */
  app.delete('/v1/devices/:deviceId', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const params = parse(z.object({ deviceId: z.string().min(1).max(96) }), request.params);
    const revoked = await context.tokens.revokeDevice(request.userId, params.deviceId, 'revoked by user');
    await context.db.run('DELETE FROM devices WHERE user_id = ? AND device_id = ?', [request.userId, params.deviceId]);
    await context.audit.record({ event: 'device_revoked', userId: request.userId, deviceId: params.deviceId, ip: clientIp(request), detail: { revokedSessions: revoked } });
    return reply.send({ revoked: params.deviceId, revokedSessions: revoked });
  });
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw AppError.validation(`Invalid request: ${result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300)}`);
  }
  return result.data;
}
