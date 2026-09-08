import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import type { AIProvider } from '@lifementor/core';
import type { ServerConfig } from './config';
import { createContext, type ServerContext } from './context';
import { registerErrorHandling } from './http/errors';
import { registerAuth } from './http/auth';
import { registerAuthRoutes } from './routes/auth';
import { registerSyncRoutes } from './routes/sync';
import { registerAiRoutes } from './routes/ai';
import { registerNewsRoutes } from './routes/news';
import { registerNotificationRoutes } from './routes/notifications';
import { registerMetaRoutes } from './routes/meta';
import type { ServerDb } from './db';
import type { JwtSigner } from './services/tokens';

export interface BuildOptions {
  /** Reuse an existing database (tests, embedding). */
  db?: ServerDb;
  /** Inject a provider instead of building one from env keys (tests, custom routing). */
  aiProvider?: AIProvider;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  context: ServerContext;
  /** Close HTTP + database. */
  shutdown(): Promise<void>;
}

/**
 * Assemble the HTTP server.
 *
 * Kept separate from `main.ts` so tests can build the exact production app and drive it with
 * `app.inject(...)` — no port, no flakiness, same routes, same middleware.
 */
export async function buildServer(config: ServerConfig, options: BuildOptions = {}): Promise<BuiltServer> {
  const app = Fastify({
    bodyLimit: config.bodyLimitBytes,
    logger: options.logger ?? config.env !== 'test'
      ? { level: config.logLevel, redact: { paths: ['req.headers.authorization', 'req.body.password', 'req.body.refresh_token'], censor: '[redacted]' } }
      : false,
    trustProxy: false,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-device-id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.general,
    timeWindow: config.rateLimit.windowMs,
    // Per IP *and* per bearer token, so one noisy user cannot exhaust another user's budget.
    keyGenerator: (request) => `${request.ip}|${tokenBucketKey(request.headers.authorization)}`,
    errorResponseBuilder: (request, context) => ({
      error: `Too many requests — retry after ${context.after}`,
      code: 'rate_limited',
      userMessage: 'Too many attempts. Please wait a moment and try again.',
    }),
    allowList: (request) => request.url === '/v1/health',
  });

  await app.register(jwt, { secret: config.jwtSecret });

  // Security headers (docs/08 §2). The API returns JSON only — never render anything.
  app.addHook('onSend', async (_request, reply) => {
    void reply
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    if (config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  registerErrorHandling(app);

  const signer: JwtSigner = {
    sign: async (payload, expiresInSeconds) => app.jwt.sign(payload, { expiresIn: expiresInSeconds }),
    verify: async (token) => app.jwt.verify<Record<string, unknown>>(token),
  };

  const context = await createContext(config, { db: options.db, jwt: signer, aiProvider: options.aiProvider });

  await registerAuth(app, context);
  await registerMetaRoutes(app, context);
  await registerAuthRoutes(app, context);
  await registerSyncRoutes(app, context);
  await registerAiRoutes(app, context);
  registerNewsRoutes(app, context);
  registerNotificationRoutes(app, context);

  app.addHook('onClose', async () => { await context.close(); });

  return {
    app,
    context,
    async shutdown(): Promise<void> { await app.close(); },
  };
}

function tokenBucketKey(authorization: string | string[] | undefined): string {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value) return 'anonymous';
  // Hash, never store or log the token itself.
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return String(hash);
}
