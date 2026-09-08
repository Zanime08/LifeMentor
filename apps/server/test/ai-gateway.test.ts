import { describe, expect, it } from 'vitest';
import { AppError } from '@lifementor/core';
import { authHeader, createTestServer, registerUser, testConfig, StubProvider } from './helpers';

/**
 * AI gateway (docs/08 §3; req. 20, 58, 69).
 *
 * The server is the only holder of provider keys; clients send a JWT plus a generation request.
 * These tests use a provider double so the wiring — auth, validation, budget, logging, SSE — is
 * what gets verified, not a third-party model.
 */

const request = (text = 'Plan my week', extra: Record<string, unknown> = {}) => ({
  messages: [
    { role: 'system', content: 'You are the LifeMentor assistant.' },
    { role: 'user', content: text },
  ],
  tier: 'mid',
  ...extra,
});

describe('POST /v1/ai/generate', () => {
  it('answers with the provider result and logs usage without content', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token),
      payload: request('Plan my week around my exams'),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.text).toContain('stub answer');
    expect(body.provider).toBe('stub-provider');
    expect(body.model).toBe('stub-mid');
    expect(body.usage.promptTokens).toBeGreaterThan(0);
    expect(body.usage.completionTokens).toBe(9);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].messages.at(-1)?.content).toBe('Plan my week around my exams');

    // usage is logged, message content is not (req. 69)
    const usage = await server.context.db.all<Record<string, unknown>>('SELECT * FROM ai_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].endpoint).toBe('/v1/ai/generate');
    expect(usage[0].model).toBe('stub-mid');
    expect(Number(usage[0].completion_tokens)).toBe(9);
    expect(JSON.stringify(usage)).not.toContain('exams');

    const budget = await server.app.inject({ method: 'GET', url: '/v1/ai/usage', headers: authHeader(user.access_token) });
    expect(budget.json().requests).toBe(1);
    expect(budget.json().remaining).toBeLessThan(budget.json().budget);

    await server.shutdown();
  });

  it('returns tool calls when the client sent tools', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token),
      payload: request('Create a task', {
        tools: [{ name: 'create_task', description: 'Create a task', parameters: { type: 'object', properties: { title: { type: 'string' } } } }],
      }),
    });

    expect(response.json().toolCalls[0].name).toBe('create_task');
    const usage = await server.context.db.all<{ tool_names: string | null }>('SELECT tool_names FROM ai_usage');
    expect(usage[0].tool_names).toContain('create_task');

    await server.shutdown();
  });

  it('validates the request and rejects anonymous callers', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const empty = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token), payload: { messages: [] },
    });
    expect(empty.statusCode).toBe(400);

    const junk = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token), payload: { messages: [{ role: 'user' }] },
    });
    expect(junk.statusCode).toBe(400);

    const anonymous = await server.app.inject({ method: 'POST', url: '/v1/ai/generate', payload: request() });
    expect(anonymous.statusCode).toBe(401);
    expect(provider.requests).toHaveLength(0);

    await server.shutdown();
  });

  it('maps a provider failure onto 502 and logs it', async () => {
    const provider = new StubProvider();
    provider.failWith = AppError.provider('upstream model unavailable');
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token), payload: request(),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('provider');

    const errors = await server.context.audit.recent({ event: 'ai_error' });
    expect(errors.length).toBe(1);
    const usage = await server.context.db.all<{ error: string | null }>('SELECT error FROM ai_usage');
    expect(usage[0].error).toContain('upstream');

    await server.shutdown();
  });

  it('enforces the per-user daily token budget', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ config: testConfig({ AI_DAILY_TOKEN_BUDGET: '20' }), aiProvider: provider });
    const user = await registerUser(server.app);

    const first = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token), payload: request('first call'),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.app.inject({
      method: 'POST', url: '/v1/ai/generate', headers: authHeader(user.access_token), payload: request('second call'),
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('rate_limited');
    expect(second.json().userMessage).toMatch(/budget/i);

    const exceeded = await server.context.audit.recent({ event: 'ai_budget_exceeded' });
    expect(exceeded.length).toBe(1);
    expect(provider.requests).toHaveLength(1); // the blocked call never reached the provider

    await server.shutdown();
  });
});

describe('POST /v1/ai/structured', () => {
  it('returns validated JSON data', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/structured', headers: authHeader(user.access_token),
      payload: request('Extract the goal', { jsonSchema: { type: 'object', properties: { answer: { type: 'number' } } } }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ answer: 42, tier: 'mid' });

    await server.shutdown();
  });
});

describe('POST /v1/ai/embed', () => {
  it('returns one vector per text and caps the batch', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const ok = await server.app.inject({
      method: 'POST', url: '/v1/ai/embed', headers: authHeader(user.access_token),
      payload: { texts: ['a memory about running', 'a memory about spanish'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().vectors).toHaveLength(2);
    expect(ok.json().vectors[0]).toHaveLength(4);

    const tooMany = await server.app.inject({
      method: 'POST', url: '/v1/ai/embed', headers: authHeader(user.access_token),
      payload: { texts: Array.from({ length: 101 }, (_, i) => `text ${i}`) },
    });
    expect(tooMany.statusCode).toBe(400);

    await server.shutdown();
  });
});

describe('POST /v1/ai/stream', () => {
  it('streams server-sent events the client parser understands', async () => {
    const provider = new StubProvider();
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/stream', headers: { ...authHeader(user.access_token), accept: 'text/event-stream' },
      payload: request('Tell me a story'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    // replay exactly what GatewayProvider.stream does with the body
    const events = response.payload.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);

    const text = events.filter((e) => typeof e.text === 'string').map((e) => e.text as string).join('');
    expect(text).toContain('stub answer');
    expect(events.at(-1)).toMatchObject({ done: true });
    expect(events.some((e) => e.model === 'stub-mid')).toBe(true);

    await server.shutdown();
  });

  it('reports errors inside the stream', async () => {
    const provider = new StubProvider();
    provider.failWith = AppError.provider('model timeout');
    const server = await createTestServer({ aiProvider: provider });
    const user = await registerUser(server.app);

    const response = await server.app.inject({
      method: 'POST', url: '/v1/ai/stream', headers: authHeader(user.access_token), payload: request(),
    });
    expect(response.payload).toContain('model timeout');

    await server.shutdown();
  });
});
