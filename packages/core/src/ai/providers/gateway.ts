import type { z } from 'zod';
import type { AIProvider, GenerationRequest, GenerationResult, ProviderCapabilities, StreamDelta } from '../types';
import { AppError } from '../../util/result';

/**
 * Client-side provider that calls the LifeMentor server AI gateway.
 *
 * Requirement 20/58: API keys never live on Windows/Android. The device only
 * holds its own user token; the server injects provider credentials.
 *
 * The gateway speaks the same shape as AIProvider so the orchestrator is
 * identical on desktop and server — only this transport differs.
 */
export interface GatewayConfig {
  serverUrl: string;
  /**
   * Returns the current access token, refreshed by the auth layer.
   * Optional: `LifeMentorApp.create` wires it to `AuthService.accessToken()` automatically.
   */
  getToken?: () => Promise<string | null>;
  /** Device id sent with every call so the server can attribute usage. */
  deviceId?: string;
  timeoutMs?: number;
  id?: string;
}

interface GatewayWireResult {
  text: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  provider?: string;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number };
  latencyMs?: number;
  finishReason?: string;
}

export class GatewayProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = { streaming: true, structured: true, embeddings: true, tools: true, maxContextTokens: 200_000 };

  constructor(private readonly config: GatewayConfig) {
    this.id = config.id ?? 'gateway';
  }

  isAvailable(): boolean { return Boolean(this.config.serverUrl); }

  private get baseUrl(): string { return this.config.serverUrl.replace(/\/$/, ''); }

  private async token(): Promise<string | null> {
    return this.config.getToken ? this.config.getToken() : null;
  }

  private async call<T>(path: string, payload: unknown, timeoutMs = 60_000): Promise<T> {
    const token = await this.token();
    if (!token) {
      throw new AppError('unauthorized', 'Not signed in to the LifeMentor server', {
        userMessage: 'AI is unavailable offline and you are not signed in. Connect to the server or enable offline mode.',
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(this.config.deviceId ? { 'x-device-id': this.config.deviceId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        const parsed = safeParse(bodyText);
        throw new AppError(response.status === 401 ? 'unauthorized' : 'provider', parsed?.error ?? `Gateway error ${response.status}`, {
          details: parsed, userMessage: response.status === 429 ? 'AI rate limit reached — try again shortly.' : undefined,
        });
      }
      return (bodyText ? safeParse(bodyText) ?? ({} as T) : {} as T);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.network('LifeMentor server unreachable', { cause: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const wire = await this.call<GatewayWireResult>('/v1/ai/generate', serialise(request), this.config.timeoutMs ?? 60_000);
    return toResult(wire, request, this.id);
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const token = await this.token();
    if (!token) return this.generate(request).then((r) => { if (r.text) onDelta({ text: r.text }); onDelta({ done: true }); return r; });

    const controller = new AbortController();
    const timeout = this.config.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.baseUrl}/v1/ai/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`,
          ...(this.config.deviceId ? { 'x-device-id': this.config.deviceId } : {}),
        },
        body: JSON.stringify(serialise(request)),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return this.generate(request);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
      let model = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = safeParse(trimmed.slice(5).trim());
          if (!payload) continue;
          if (typeof payload.text === 'string' && payload.text) { text += payload.text; onDelta({ text: payload.text }); }
          if (payload.toolCall) { toolCalls.push(payload.toolCall); onDelta({ toolCall: payload.toolCall }); }
          if (payload.model) model = payload.model;
        }
      }
      onDelta({ done: true });
      return toResult({ text, toolCalls, model }, request, this.id);
    } catch (error) {
      onDelta({ error: error instanceof Error ? error.message : String(error) });
      onDelta({ done: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    const wire = await this.call<{ data: unknown }>('/v1/ai/structured', serialise(request), this.config.timeoutMs ?? 90_000);
    const parsed = schema.safeParse(wire.data ?? null);
    if (!parsed.success) {
      throw new AppError('provider', 'Gateway returned invalid structured data', { details: parsed.error.issues.slice(0, 10) });
    }
    return parsed.data;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const wire = await this.call<{ vectors: number[][] }>('/v1/ai/embed', { texts }, this.config.timeoutMs ?? 60_000);
    return wire.vectors ?? [];
  }
}

/** Strip non-serialisable fields (AbortSignal, schemas stay as plain JSON). */
function serialise(request: GenerationRequest): Record<string, unknown> {
  const { signal: _signal, jsonSchema: schema, ...rest } = request;
  return { ...rest, ...(schema ? { jsonSchema: schema } : {}) };
}

function toResult(wire: GatewayWireResult, request: GenerationRequest, providerId: string): GenerationResult {
  return {
    text: wire.text ?? '',
    toolCalls: wire.toolCalls ?? [],
    provider: wire.provider ?? providerId,
    model: wire.model ?? request.tier ?? 'gateway',
    tier: request.tier ?? 'mid',
    usage: wire.usage ?? { promptTokens: 0, completionTokens: 0 },
    latencyMs: wire.latencyMs ?? 0,
    finishReason: wire.finishReason ?? 'stop',
  };
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}
