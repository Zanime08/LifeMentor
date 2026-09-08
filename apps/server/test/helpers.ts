import type { FastifyInstance } from 'fastify';
import type { AIProvider, GenerationRequest, GenerationResult, ProviderCapabilities, StreamDelta } from '@lifementor/core';
import type { z } from 'zod';
import { buildServer, type BuiltServer } from '../src/app';
import { loadConfig, type ServerConfig } from '../src/config';
import type { ServerContext } from '../src/context';

/**
 * Test harness: the real production server, in-process, with an in-memory database.
 * Routes, middleware, validation, rate limits and SQL are exactly what ships.
 */

export function testConfig(overrides: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_IN_MEMORY: 'true',
    JWT_SECRET: 'test-secret-value-long-enough-0123456789',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_AUTH: '10000',
    RATE_LIMIT_SYNC: '10000',
    RATE_LIMIT_AI: '10000',
    RATE_LIMIT_GENERAL: '100000',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

export async function createTestServer(options: { config?: ServerConfig; aiProvider?: AIProvider } = {}): Promise<BuiltServer> {
  return buildServer(options.config ?? testConfig(), { aiProvider: options.aiProvider, logger: false });
}

/** Register a user and return the tokens the server issued. */
export async function registerUser(
  app: FastifyInstance,
  input: { email?: string; password?: string; device_id?: string; display_name?: string } = {},
): Promise<{ user_id: string; email: string; access_token: string; refresh_token: string; access_expires_at: string; plan: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: input.email ?? `user-${Math.random().toString(36).slice(2, 9)}@example.com`,
      password: input.password ?? 'a-strong-passphrase',
      display_name: input.display_name ?? null,
      device_id: input.device_id ?? 'device-test',
    },
  });
  if (response.statusCode !== 201) throw new Error(`register failed (${response.statusCode}): ${response.body}`);
  return response.json();
}

export function authHeader(token: string, deviceId = 'device-test'): { authorization: string; 'x-device-id': string } {
  return { authorization: `Bearer ${token}`, 'x-device-id': deviceId };
}

/** Deterministic provider double — the server's AI wiring is what is under test, not a model. */
export class StubProvider implements AIProvider {
  readonly id = 'stub-provider';
  readonly capabilities: ProviderCapabilities = { streaming: true, structured: true, embeddings: true, tools: true, maxContextTokens: 8_000 };
  readonly requests: GenerationRequest[] = [];
  failWith: Error | null = null;

  isAvailable(): boolean { return true; }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    const prompt = request.messages.map((m) => m.content).join(' ');
    return {
      text: `stub answer to: ${prompt.slice(-60)}`,
      toolCalls: request.tools?.length
        ? [{ id: 'call-1', name: request.tools[0].name, arguments: { probe: true } }]
        : [],
      provider: this.id,
      model: `stub-${request.tier ?? 'mid'}`,
      tier: request.tier ?? 'mid',
      usage: { promptTokens: Math.max(1, Math.round(prompt.length / 4)), completionTokens: 9 },
      latencyMs: 2,
      finishReason: 'stop',
    };
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const result = await this.generate(request);
    for (const chunk of result.text.match(/.{1,12}/gs) ?? []) onDelta({ text: chunk });
    for (const call of result.toolCalls) onDelta({ toolCall: call });
    onDelta({ done: true });
    return result;
  }

  async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    const result = await this.generate(request);
    return schema.parse({ answer: 42, text: result.text, tier: request.tier ?? 'mid' }) as T;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.failWith) throw this.failWith;
    return texts.map((text) => [text.length / 100, 0.5, 0.25, 0.125]);
  }
}

export async function withServer<T>(options: { config?: ServerConfig; aiProvider?: AIProvider }, run: (server: BuiltServer & { context: ServerContext }) => Promise<T>): Promise<T> {
  const server = await createTestServer(options);
  try {
    return await run(server);
  } finally {
    await server.shutdown();
  }
}
