import { z } from 'zod';
import { AppError, LocalHeuristicProvider, createProviderChain, newId, nowIso } from '@lifementor/core';
import type { AIProvider, GenerationRequest, GenerationResult, ProviderConfig, StreamDelta } from '@lifementor/core';
import type { ServerConfig } from '../config';
import type { ServerDb } from '../db';
import type { AuditLog } from './audit';

/**
 * AI gateway (docs/08 §3; req. 20, 58).
 *
 * This is the only place in the whole product where a provider API key exists. Clients send their
 * user JWT plus a generation request; the server authenticates, rate-limits, applies a per-user
 * daily token budget, calls the provider, and logs `{user, model, tokens, latency, tools, error}`
 * — never key material and never message content (req. 69).
 *
 * With no keys configured the gateway falls back to the core's local heuristic provider, so a
 * self-hosted server still answers (degraded but honest) instead of failing.
 */

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
});

const toolSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(4000),
  parameters: z.record(z.unknown()),
});

export const GenerationRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(200),
  tools: z.array(toolSchema).max(80).optional(),
  tier: z.enum(['cheap', 'mid', 'strong']).optional(),
  intent: z.string().max(120).optional(),
  maxTokens: z.number().int().positive().max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  jsonSchema: z.record(z.unknown()).optional(),
});

export const EmbedRequestSchema = z.object({
  texts: z.array(z.string().min(1).max(20_000)).min(1).max(100),
});

export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
  requests: number;
  budget: number;
  remaining: number;
}

export class AiGateway {
  readonly provider: AIProvider;

  constructor(
    private readonly db: ServerDb,
    private readonly audit: AuditLog,
    private readonly config: ServerConfig,
    provider?: AIProvider,
  ) {
    this.provider = provider ?? buildProvider(config);
  }

  get providerId(): string { return this.provider.id; }

  /** Non-streaming generation → the wire shape `GatewayProvider.generate` expects. */
  async generate(userId: string, deviceId: string | null, body: unknown, meta: { endpoint: string; ip?: string | null }): Promise<GenerationResult> {
    const request = parseRequest(body, this.config.ai.maxInputChars);
    await this.assertBudget(userId, meta.endpoint, meta.ip);
    return this.run(userId, deviceId, request, meta.endpoint, () => this.provider.generate(request), meta.ip);
  }

  /** JSON-mode generation → `{ data }`. */
  async structured(userId: string, deviceId: string | null, body: unknown, meta: { endpoint: string; ip?: string | null }): Promise<{ data: unknown }> {
    const request = parseRequest(body, this.config.ai.maxInputChars);
    await this.assertBudget(userId, meta.endpoint, meta.ip);
    const data = await this.run(userId, deviceId, request, meta.endpoint,
      () => this.provider.generateStructured(request, z.unknown() as z.ZodType<unknown>), meta.ip);
    return { data };
  }

  /** Embeddings → `{ vectors }`. */
  async embed(userId: string, deviceId: string | null, body: unknown, meta: { endpoint: string; ip?: string | null }): Promise<{ vectors: number[][] }> {
    const parsed = EmbedRequestSchema.safeParse(body);
    if (!parsed.success) throw AppError.validation(`Invalid embed request: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    await this.assertBudget(userId, meta.endpoint, meta.ip);
    const started = Date.now();
    try {
      const vectors = await this.provider.embed(parsed.data.texts);
      await this.logUsage({ userId, deviceId, endpoint: meta.endpoint, result: null, latencyMs: Date.now() - started, error: null, extra: parsed.data.texts.length });
      return { vectors };
    } catch (error) {
      await this.logUsage({ userId, deviceId, endpoint: meta.endpoint, result: null, latencyMs: Date.now() - started, error: messageOf(error) });
      throw toProviderError(error);
    }
  }

  /** Streaming generation: every delta is handed to the caller (the route writes SSE). */
  async stream(
    userId: string, deviceId: string | null, body: unknown,
    meta: { endpoint: string; ip?: string | null },
    onDelta: (delta: StreamDelta) => void,
  ): Promise<GenerationResult> {
    const request = parseRequest(body, this.config.ai.maxInputChars);
    await this.assertBudget(userId, meta.endpoint, meta.ip);
    return this.run(userId, deviceId, request, meta.endpoint, () => this.provider.stream(request, onDelta), meta.ip);
  }

  /** Today's consumption for one user. */
  async usageToday(userId: string): Promise<GatewayUsage> {
    const day = nowIso().slice(0, 10);
    const row = await this.db.get<{ prompt: number | null; completion: number | null; requests: number | null }>(
      `SELECT SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, COUNT(*) AS requests
       FROM ai_usage WHERE user_id = ? AND substr(created_at, 1, 10) = ?`,
      [userId, day],
    );
    const promptTokens = Number(row?.prompt ?? 0);
    const completionTokens = Number(row?.completion ?? 0);
    const used = promptTokens + completionTokens;
    return {
      promptTokens, completionTokens, requests: Number(row?.requests ?? 0),
      budget: this.config.ai.dailyTokenBudget,
      remaining: Math.max(0, this.config.ai.dailyTokenBudget - used),
    };
  }

  // ─────────────────────────── internals ───────────────────────────
  private async assertBudget(userId: string, endpoint: string, ip?: string | null): Promise<void> {
    const usage = await this.usageToday(userId);
    if (usage.budget > 0 && usage.remaining <= 0) {
      await this.audit.record({ event: 'ai_budget_exceeded', userId, ip, detail: { endpoint, used: usage.promptTokens + usage.completionTokens } });
      throw new AppError('rate_limited', 'Daily AI token budget reached', {
        details: { budget: usage.budget },
        userMessage: 'You have reached today\'s AI budget. The app keeps working offline — try again tomorrow or raise the budget on the server.',
      });
    }
  }

  private async run<T>(
    userId: string, deviceId: string | null, request: GenerationRequest, endpoint: string,
    call: () => Promise<T>, ip?: string | null,
  ): Promise<T> {
    const started = Date.now();
    try {
      const value = await call();
      const result = (value && typeof value === 'object' && 'usage' in (value as object)) ? value as unknown as GenerationResult : null;
      await this.logUsage({ userId, deviceId, endpoint, result, latencyMs: Date.now() - started, error: null, request });
      return value;
    } catch (error) {
      await this.logUsage({ userId, deviceId, endpoint, result: null, latencyMs: Date.now() - started, error: messageOf(error), request });
      await this.audit.record({ event: 'ai_error', userId, deviceId, ip, detail: { endpoint, error: messageOf(error).slice(0, 200) } });
      throw toProviderError(error);
    }
  }

  private async logUsage(entry: {
    userId: string; deviceId: string | null; endpoint: string; result: GenerationResult | null;
    latencyMs: number; error: string | null; request?: GenerationRequest; extra?: number;
  }): Promise<void> {
    const usage = entry.result?.usage;
    await this.db.run(
      `INSERT INTO ai_usage (id, user_id, device_id, endpoint, provider, model, tier, prompt_tokens, completion_tokens, latency_ms, tool_names, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('op'), entry.userId, entry.deviceId, entry.endpoint,
        entry.result?.provider ?? this.provider.id, entry.result?.model ?? null, entry.request?.tier ?? entry.result?.tier ?? null,
        Number(usage?.promptTokens ?? 0), Number(usage?.completionTokens ?? 0), Math.round(entry.latencyMs),
        entry.request?.tools?.length ? JSON.stringify(entry.request.tools.map((t) => t.name).slice(0, 40)) : null,
        entry.error?.slice(0, 400) ?? null, nowIso(),
      ],
    );
  }
}

/** Providers are built from env keys only; the order defines the fallback chain (req. 26). */
export function buildProvider(config: ServerConfig): AIProvider {
  const chain: ProviderConfig[] = [];
  const models = config.ai.models;
  if (config.ai.openaiKey) chain.push({ kind: 'openai', apiKey: config.ai.openaiKey, baseUrl: config.ai.openaiBaseUrl ?? undefined, models });
  if (config.ai.anthropicKey) chain.push({ kind: 'anthropic', apiKey: config.ai.anthropicKey, baseUrl: config.ai.anthropicBaseUrl ?? undefined, models });
  if (config.ai.googleKey) chain.push({ kind: 'google', apiKey: config.ai.googleKey, baseUrl: config.ai.googleBaseUrl ?? undefined, models });
  if (!chain.length) return new LocalHeuristicProvider({ id: 'local-heuristic' });
  return createProviderChain(chain);
}

export function parseRequest(body: unknown, maxInputChars: number): GenerationRequest {
  const parsed = GenerationRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw AppError.validation(`Invalid AI request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)}`);
  }
  const messages = parsed.data.messages as { role: string; content: string }[];
  const chars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  if (chars > maxInputChars) {
    throw AppError.validation(`Request is too large (${chars} characters, max ${maxInputChars})`);
  }
  return parsed.data as GenerationRequest;
}

function toProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return AppError.provider(messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
