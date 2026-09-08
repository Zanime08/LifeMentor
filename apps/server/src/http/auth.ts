import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@lifementor/core';
import type { ServerContext } from '../context';

/**
 * Request authentication (docs/08 §2).
 *
 * `userId` always comes from the verified access token — never from the body or a query string —
 * and every repository query on the server is scoped by it. The device id travels in
 * `x-device-id` (or the token's `did` claim) and is used for attribution and device revocation.
 */

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    deviceId: string;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = String(header).split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

export function requestDeviceId(request: FastifyRequest): string {
  const header = request.headers['x-device-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return String(fromHeader ?? request.deviceId ?? '').slice(0, 96);
}

export function clientIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}

/** preHandler: rejects the request unless a valid access token for a live account is present. */
export function authenticate(context: ServerContext) {
  return async function verify(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = bearerToken(request);
    if (!token) {
      void reply.status(401).send({ error: 'Missing access token', code: 'unauthorized', userMessage: 'Please sign in to use sync and cloud AI.' });
      return;
    }
    let claims: { userId: string; deviceId: string };
    try {
      claims = await context.tokens.verifyAccess(token);
    } catch (error) {
      const message = error instanceof AppError ? error.message : 'Invalid access token';
      void reply.status(401).send({ error: message, code: 'unauthorized', userMessage: 'Your session expired. Please sign in again.' });
      return;
    }

    const user = await context.users.findById(claims.userId);
    if (!user) {
      void reply.status(401).send({ error: 'Account no longer exists', code: 'unauthorized' });
      return;
    }

    request.userId = claims.userId;
    request.deviceId = requestDeviceId(request) || claims.deviceId;
  };
}

/** Attach the authenticate preHandler to the instance as a reusable decorator. */
export async function registerAuth(app: FastifyInstance, context: ServerContext): Promise<void> {
  app.decorateRequest('userId', '');
  app.decorateRequest('deviceId', '');
  app.decorate('authenticate', authenticate(context));
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: ReturnType<typeof authenticate>;
  }
}
