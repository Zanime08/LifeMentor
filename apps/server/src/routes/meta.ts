import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { SERVER_NAME, SERVER_VERSION } from '../context';

/**
 * Health and version endpoints (docs/08 §1).
 *
 * `HttpSyncTransport.health()` reads `{ok, time}`; the desktop/mobile diagnostics screen reads
 * the rest. No secrets, no personal data.
 */
export async function registerMetaRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const startedAt = Date.now();

  app.get('/v1/health', async (_request, reply) => {
    const integrity = await context.db.integrityCheck();
    return reply.status(integrity.ok ? 200 : 500).send({
      ok: integrity.ok,
      time: new Date().toISOString(),
      version: SERVER_VERSION,
      env: context.config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      database: context.db.describe(),
      integrity,
      ai: { provider: context.ai.providerId, cloudKeys: countKeys(context) },
    });
  });

  app.get('/v1/version', async () => ({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    schemaVersion: await context.db.schemaVersion(),
    node: process.version,
    endpoints: PUBLIC_ENDPOINTS,
  }));

  app.get('/', async () => ({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    docs: 'https://github.com/Zanime08/LifeMentor#readme',
    health: '/v1/health',
  }));
}

const PUBLIC_ENDPOINTS = [
  'GET /v1/health', 'GET /v1/version',
  'POST /v1/auth/register', 'POST /v1/auth/login', 'POST /v1/auth/refresh', 'POST /v1/auth/logout',
  'POST /v1/auth/password/change', 'POST /v1/account/delete',
  'POST /v1/sync/push', 'GET /v1/sync/pull', 'GET /v1/sync/status',
  'GET /v1/devices', 'DELETE /v1/devices/:deviceId',
  'POST /v1/ai/generate', 'POST /v1/ai/structured', 'POST /v1/ai/embed', 'POST /v1/ai/stream', 'GET /v1/ai/usage',
];

function countKeys(context: ServerContext): { openai: boolean; anthropic: boolean; google: boolean } {
  return {
    openai: Boolean(context.config.ai.openaiKey),
    anthropic: Boolean(context.config.ai.anthropicKey),
    google: Boolean(context.config.ai.googleKey),
  };
}
