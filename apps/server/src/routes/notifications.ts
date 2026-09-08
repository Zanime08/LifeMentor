import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lifementor/core';
import type { ServerContext } from '../context';
import { clientIp, requestDeviceId } from '../http/auth';

/**
 * Notification endpoints (docs/08 §1, §5).
 *
 * Push is the secondary channel: the primary one is local scheduling on the device. These routes
 * implement the secondary one — Web Push subscriptions + a server-side queue the client polls
 * (`GET /v1/notifications/pending` → `POST /v1/notifications/:id/delivered`), so nothing is lost
 * when the tab is closed or the push attempt fails.
 */

const webSubscriptionSchema = z.object({
  endpoint: z.string().min(20).max(2000),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(10) }),
});

const pushTokenSchema = z.union([
  z.object({
    kind: z.literal('web'),
    subscription: webSubscriptionSchema,
    userAgent: z.string().max(400).optional(),
  }),
  z.object({
    kind: z.literal('fcm'),
    token: z.string().min(10).max(1000),
  }),
]);

const removePushTokenSchema = z.object({ endpoint: z.string().min(1).max(2000) });

export function registerNotificationRoutes(app: FastifyInstance, context: ServerContext): void {
  const limit = { config: { rateLimit: { max: context.config.rateLimit.sync, timeWindow: context.config.rateLimit.windowMs } } };
  const strict = { config: { rateLimit: { max: 30, timeWindow: context.config.rateLimit.windowMs } } };
  const rare = { config: { rateLimit: { max: 10, timeWindow: context.config.rateLimit.windowMs } } };

  /** The VAPID public key the browser needs to subscribe. */
  app.get('/v1/notifications/push/vapid-public-key', { ...strict, preHandler: app.authenticate }, async () => ({
    publicKey: context.push.vapidPublicKey,
  }));

  /** Register a Web Push subscription (or, later, an FCM token) for this account. */
  app.post('/v1/notifications/push-token', { ...strict, preHandler: app.authenticate }, async (request, reply) => {
    const body = parse(pushTokenSchema, request.body);
    if (body.kind === 'web') {
      const result = await context.push.addSubscription(request.userId, requestDeviceId(request) || 'unknown', {
        kind: 'web',
        endpoint: body.subscription.endpoint,
        p256dh: body.subscription.keys.p256dh,
        authSecret: body.subscription.keys.auth,
        userAgent: body.userAgent,
      });
      return reply.send({ ok: true, ...result });
    }
    const result = await context.push.addSubscription(request.userId, requestDeviceId(request) || 'unknown', {
      kind: 'fcm',
      endpoint: body.token,
    });
    return reply.send({ ok: true, ...result });
  });

  app.delete('/v1/notifications/push-token', { ...strict, preHandler: app.authenticate }, async (request, reply) => {
    const body = parse(removePushTokenSchema, request.body ?? {});
    const removed = await context.push.removeSubscription(request.userId, body.endpoint);
    return reply.send({ ok: true, removed });
  });

  /** Polling fallback: everything undelivered and unexpired, oldest first. */
  app.get('/v1/notifications/pending', { ...limit, preHandler: app.authenticate }, async (request) => {
    const { limit: limitParam } = (request.query ?? {}) as { limit?: string };
    const limitNum = Math.min(100, Math.max(1, Number(limitParam ?? 50) || 50));
    const notifications = await context.push.pending(request.userId, limitNum);
    return { notifications };
  });

  /** The client processed a notification (shown, or gated locally) — it will not be re-pushed. */
  app.post('/v1/notifications/:id/delivered', { ...limit, preHandler: app.authenticate }, async (request, reply) => {
    const params = parse(z.object({ id: z.string().min(1).max(64) }), request.params);
    const ok = await context.push.markDelivered(request.userId, params.id);
    return reply.send({ ok });
  });

  /** Diagnostics: send a test push to this account (Settings → Notifications). */
  app.post('/v1/notifications/test', { ...rare, preHandler: app.authenticate }, async (request, reply) => {
    const result = await context.push.notify(request.userId, {
      type: 'mentor_message',
      title: 'LifeMentor',
      body: 'Тестовое уведомление: доставка работает.',
      data: { test: true },
      dedupKey: `test:${Date.now()}:${randomUUID().slice(0, 8)}`,
      ttlHours: 1,
    });
    await context.audit.record({
      event: 'push_test', userId: request.userId, deviceId: requestDeviceId(request), ip: clientIp(request),
      detail: { push: result.push, error: result.error ?? null },
    });
    return reply.send({ ok: result.push !== 'failed', ...result });
  });
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw AppError.validation(`Invalid request: ${result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300)}`);
  }
  return result.data;
}
