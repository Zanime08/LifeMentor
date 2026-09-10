import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';

/**
 * News endpoints (docs/08 §4). Clients pull the server's structured feed and
 * ingest it into their local SQLite, where it stays readable offline.
 */
export function registerNewsRoutes(app: FastifyInstance, context: ServerContext): void {
  const limit = { config: { rateLimit: { max: context.config.rateLimit.sync, timeWindow: context.config.rateLimit.windowMs } } };

  app.get('/v1/news', { ...limit, preHandler: app.authenticate }, async (request) => {
    const { limit: limitParam } = (request.query ?? {}) as { limit?: string };
    const limitNum = Math.min(200, Math.max(1, Number(limitParam ?? 80) || 80));
    return context.news.items(limitNum);
  });

  app.post('/v1/news/refresh', { ...limit, preHandler: app.authenticate }, async (request) => {
    const result = await context.news.refresh();
    request.log.info({ ok: result.ok, failed: result.failed, added: result.added }, 'manual news refresh');
    return result;
  });

  app.get('/v1/news/stats', { ...limit, preHandler: app.authenticate }, async () => {
    return context.news.sourceStats();
  });
}
