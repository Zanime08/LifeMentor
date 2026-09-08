import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@lifementor/core';

/**
 * One error shape for the whole API.
 *
 * Clients (`HttpAuthTransport`, `HttpSyncTransport`, `GatewayProvider`) read `error` for the
 * message and map the HTTP status onto their own typed errors, so the body stays small and
 * stable: `{ error, code, userMessage? }` — never a stack trace, never a secret.
 */

const STATUS_BY_CODE: Record<string, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unsupported: 501,
  provider: 502,
  network: 503,
  storage: 500,
  integrity: 500,
  unknown: 500,
};

/**
 * `@fastify/rate-limit` answers through `errorResponseBuilder`, so the thrown object carries the
 * built body (`code: 'rate_limited'`) but no HTTP status — recognise it explicitly.
 */
function isRateLimited(error: { code?: string } | null | undefined): boolean {
  const code = error?.code;
  return code === 'rate_limited' || (typeof code === 'string' && code.startsWith('FST_RATE_LIMIT'));
}

export function statusForError(error: unknown): number {
  if (error instanceof AppError) return STATUS_BY_CODE[error.code] ?? 500;
  const fastifyError = error as FastifyError & { statusCode?: number; code?: string };
  if (isRateLimited(fastifyError)) return 429;
  if (typeof fastifyError?.statusCode === 'number' && fastifyError.statusCode >= 400) return fastifyError.statusCode;
  if (fastifyError?.code === 'FST_REQ_TIMEOUT') return 408;
  if (fastifyError?.code === 'FST_FILES_LIMIT' || fastifyError?.code === 'FST_BODY_SIZE_LIMIT') return 413;
  return 500;
}

export function errorBody(error: unknown): { error: string; code: string; userMessage?: string } {
  if (error instanceof AppError) {
    return {
      error: error.message,
      code: error.code,
      ...(error.userMessage && error.userMessage !== error.message ? { userMessage: error.userMessage } : {}),
    };
  }
  const fastifyError = error as FastifyError & { code?: string; error?: string; userMessage?: string };
  const status = statusForError(error);
  if (isRateLimited(fastifyError)) {
    return {
      error: fastifyError.error ?? fastifyError.message ?? 'Too many requests — please slow down',
      code: 'rate_limited',
      userMessage: fastifyError.userMessage ?? 'Too many attempts. Please wait a moment and try again.',
    };
  }
  if (status === 413) return { error: 'Request body is too large', code: 'validation' };
  if (status >= 500) {
    // Internal failures are logged with detail but reported generically.
    return { error: 'The server could not complete that request', code: 'unknown' };
  }
  return { error: fastifyError?.message || 'Request failed', code: 'unknown' };
}

/** Install the error + not-found handlers on a Fastify instance. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = statusForError(error);
    if (status >= 500) request.log.error({ err: error, url: request.url }, 'request failed');
    else request.log.debug({ err: error, url: request.url, status }, 'request rejected');
    void reply.status(status).send(errorBody(error));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: `No such endpoint: ${request.method} ${request.url}`, code: 'not_found' });
  });
}
