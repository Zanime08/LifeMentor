import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, nowIso } from '@lifementor/core';
import type { ServerContext } from '../context';
import { clientIp, requestDeviceId } from '../http/auth';
import { toPublic } from '../services/users';
import { hashToken } from '../services/tokens';

/**
 * Auth endpoints (docs/08 §1–2; req. 57).
 *
 * `HttpAuthTransport` in the core package speaks exactly this contract, so the Windows, Android
 * and web clients all use the same code path.
 */

const credentialsSchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(512),
  display_name: z.string().max(120).nullish(),
  device_id: z.string().min(1).max(96),
});

const loginSchema = credentialsSchema.omit({ display_name: true });
const refreshSchema = z.object({ refresh_token: z.string().min(8).max(512), device_id: z.string().min(1).max(96) });
const logoutSchema = z.object({ refresh_token: z.string().min(8).max(512) });
const passwordSchema = z.object({ current_password: z.string().min(1).max(512), new_password: z.string().min(10).max(512) });

export async function registerAuthRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const limit = { config: { rateLimit: { max: context.config.rateLimit.auth, timeWindow: context.config.rateLimit.windowMs } } };

  app.post('/v1/auth/register', { ...limit, schema: { body: zodToJson(credentialsSchema) } }, async (request, reply) => {
    const input = parse(credentialsSchema, request.body);
    const ip = clientIp(request);
    const deviceId = input.device_id || requestDeviceId(request);

    const user = await context.users.create({
      email: input.email, password: input.password, displayName: input.display_name ?? null,
    });
    const tokens = await context.tokens.issue(user.user_id, deviceId);
    await context.audit.record({ event: 'register', userId: user.user_id, deviceId, ip, detail: { plan: user.plan } });

    return reply.status(201).send({ ...user, ...tokens });
  });

  app.post('/v1/auth/login', { ...limit, schema: { body: zodToJson(loginSchema) } }, async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const ip = clientIp(request);
    const deviceId = input.device_id || requestDeviceId(request);

    try {
      const user = await context.users.authenticate(input.email, input.password);
      const tokens = await context.tokens.issue(user.user_id, deviceId);
      await context.audit.record({ event: 'login', userId: user.user_id, deviceId, ip });
      return reply.send({ ...toPublic(user), ...tokens });
    } catch (error) {
      await context.audit.record({ event: 'login_failed', deviceId, ip, detail: { reason: error instanceof Error ? error.message : 'unknown' } });
      throw error;
    }
  });

  app.post('/v1/auth/refresh', { ...limit, schema: { body: zodToJson(refreshSchema) } }, async (request, reply) => {
    const input = parse(refreshSchema, request.body);
    const ip = clientIp(request);
    const tokens = await context.tokens.rotate(input.refresh_token, input.device_id);
    const claims = await context.tokens.verifyAccess(tokens.access_token);
    const user = await context.users.findById(claims.userId);
    if (!user) throw AppError.unauthorized('Account no longer exists');
    await context.audit.record({ event: 'refresh', userId: user.user_id, deviceId: input.device_id, ip });
    return reply.send({ ...toPublic(user), ...tokens });
  });

  app.post('/v1/auth/logout', { ...limit, schema: { body: zodToJson(logoutSchema) } }, async (request, reply) => {
    const input = parse(logoutSchema, request.body);
    // Logging out must never fail because a token was already gone.
    await context.tokens.revoke(hashToken(input.refresh_token), 'logout');
    await context.audit.record({ event: 'logout', deviceId: requestDeviceId(request), ip: clientIp(request) });
    return reply.send({ ok: true });
  });

  app.post('/v1/auth/password/change', {
    ...limit,
    preHandler: app.authenticate,
    schema: { body: zodToJson(passwordSchema) },
  }, async (request, reply) => {
    const input = parse(passwordSchema, request.body);
    await context.users.changePassword(request.userId, input.current_password, input.new_password);
    // Every existing session is invalidated; the user signs in again with the new password.
    const revoked = await context.tokens.revokeAllForUser(request.userId, 'password changed');
    await context.audit.record({ event: 'password_changed', userId: request.userId, deviceId: request.deviceId, ip: clientIp(request), detail: { revokedSessions: revoked } });
    return reply.send({ changed: true, revokedSessions: revoked });
  });

  /** Account deletion (req. 56): the server wipes everything it holds and returns a receipt. */
  app.post('/v1/account/delete', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.userId;
    const ip = clientIp(request);
    const deletedAt = nowIso();
    const receipt = `deleted_${userId}_${deletedAt.replace(/[:.]/g, '-')}`;

    await context.tokens.revokeAllForUser(userId, 'account deleted');
    const purged = await context.users.purge(userId);
    await context.audit.record({ event: 'account_deleted', userId, deviceId: request.deviceId, ip, detail: { rows: purged.rows, receipt } });

    return reply.send({ receipt, deleted_at: deletedAt, purged_rows: purged.rows });
  });
}

// ─────────────────────────── helpers ───────────────────────────
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw AppError.validation(`Invalid request: ${result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300)}`);
  }
  return result.data;
}

/**
 * Fastify validates with its own JSON-schema compiler; we keep Zod as the single source of truth
 * and hand Fastify a permissive schema so it only enforces "this is an object".
 */
function zodToJson(_schema: z.ZodTypeAny): Record<string, unknown> {
  return { type: 'object', additionalProperties: true };
}
