import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { clientIp, requestDeviceId } from '../http/auth';
import { errorBody, statusForError } from '../http/errors';

/**
 * AI gateway endpoints (docs/08 §3; req. 20, 58).
 *
 * The client's `GatewayProvider` calls exactly these four paths. Provider keys never leave this
 * process: the request carries a user JWT, the server adds credentials, enforces the daily token
 * budget and logs usage without any message content.
 */

export async function registerAiRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const limit = { config: { rateLimit: { max: context.config.rateLimit.ai, timeWindow: context.config.rateLimit.windowMs } } };

  app.post('/v1/ai/generate', { ...limit, preHandler: app.authenticate }, async (request) => {
    const result = await context.ai.generate(request.userId, requestDeviceId(request), request.body, {
      endpoint: '/v1/ai/generate', ip: clientIp(request),
    });
    return {
      text: result.text,
      toolCalls: result.toolCalls ?? [],
      provider: result.provider,
      model: result.model,
      usage: result.usage ?? { promptTokens: 0, completionTokens: 0 },
      latencyMs: result.latencyMs ?? 0,
      finishReason: result.finishReason ?? 'stop',
    };
  });

  app.post('/v1/ai/structured', { ...limit, preHandler: app.authenticate }, async (request) => {
    return context.ai.structured(request.userId, requestDeviceId(request), request.body, {
      endpoint: '/v1/ai/structured', ip: clientIp(request),
    });
  });

  app.post('/v1/ai/embed', { ...limit, preHandler: app.authenticate }, async (request) => {
    return context.ai.embed(request.userId, requestDeviceId(request), request.body, {
      endpoint: '/v1/ai/embed', ip: clientIp(request),
    });
  });

  /** Server-sent events: `data: {"text": "…"}` / `{"toolCall": …}` / `{"done": true}`. */
  app.post('/v1/ai/stream', { ...limit, preHandler: app.authenticate }, async (request: FastifyRequest, reply: FastifyReply) => {
    const deviceId = requestDeviceId(request);
    const ip = clientIp(request);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (payload: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await context.ai.stream(request.userId, deviceId, request.body, { endpoint: '/v1/ai/stream', ip }, (delta) => {
        if (delta.text) send({ text: delta.text });
        if (delta.toolCall) send({ toolCall: delta.toolCall });
        if (delta.error) send({ error: delta.error });
      });
      send({ done: true, model: result.model, provider: result.provider, usage: result.usage ?? null });
    } catch (error) {
      const status = statusForError(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(status, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(errorBody(error)));
        return reply;
      }
      send({ error: errorBody(error).error, done: true });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /** Budget visibility for the client's Settings → AI screen. */
  app.get('/v1/ai/usage', { ...limit, preHandler: app.authenticate }, async (request) => {
    const usage = await context.ai.usageToday(request.userId);
    return { ...usage, provider: context.ai.providerId, day: new Date().toISOString().slice(0, 10) };
  });
}
