import type { z } from 'zod';
import type { AIProvider, GenerationRequest, GenerationResult, ModelTier, ProviderCapabilities, StreamDelta, ToolCallRequest } from '../types';
import { estimateTokens } from '../types';
import { AppError } from '../../util/result';
import { createLogger } from '../../util/logging';

const log = createLogger('ai');

export interface TierModels { cheap: string; mid: string; strong: string }

async function fetchWithRetry(url: string, init: RequestInit, options: { retries?: number; timeoutMs?: number } = {}): Promise<Response> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: options.timeoutMs ? controller.signal : (init.signal ?? controller.signal) });
      clearTimeout(timer);
      if (response.ok) return response;
      const body = await response.text().catch(() => '');
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
        await backoff(attempt, response.headers.get('retry-after'));
        continue;
      }
      throw AppError.provider(`AI provider error ${response.status}: ${body.slice(0, 400)}`, { status: response.status });
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (error instanceof AppError) throw error;
      if (attempt < retries) { await backoff(attempt); continue; }
    }
  }
  throw AppError.network('AI provider unreachable', { cause: lastError instanceof Error ? lastError.message : String(lastError) });
}

async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const seconds = retryAfter ? Number(retryAfter) : Math.min(8, 2 ** attempt) + Math.random() * 0.4;
  await new Promise((resolve) => setTimeout(resolve, Math.max(200, seconds * 1000)));
}

function tierModel(models: TierModels, tier: ModelTier = 'mid'): string {
  return models[tier] ?? models.mid;
}

async function parseJsonLoose(text: string): Promise<unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { /* keep trying */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()); } catch { /* keep trying */ } }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ } }
  const arrFirst = trimmed.indexOf('[');
  const arrLast = trimmed.lastIndexOf(']');
  if (arrFirst >= 0 && arrLast > arrFirst) { try { return JSON.parse(trimmed.slice(arrFirst, arrLast + 1)); } catch { /* fall through */ } }
  throw AppError.provider('Model did not return valid JSON', { preview: trimmed.slice(0, 200) });
}

/** Shared structured-output loop: request → parse → validate → one repair attempt. */
async function structured<T>(provider: AIProvider, request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
  const first = await provider.generate(request);
  const payload = first.text ? await parseJsonLoose(first.text) : {};
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;

  log.warn('structured output failed validation, retrying with the error', { issues: parsed.error.issues.slice(0, 5) });
  const repair = await provider.generate({
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: first.text || '{}' },
      {
        role: 'user',
        content: `That output did not validate. Errors: ${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}. `
          + 'Return ONLY corrected JSON matching the schema exactly. No prose, no code fences.',
      },
    ],
  });
  const second = await parseJsonLoose(repair.text);
  const reParse = schema.safeParse(second);
  if (!reParse.success) {
    throw new AppError('provider', 'Model output failed schema validation twice', {
      details: reParse.error.issues.slice(0, 10),
      userMessage: 'The AI returned data in an unexpected shape. Nothing was saved — please try again.',
    });
  }
  return reParse.data;
}

// ─────────────────────────── OpenAI-compatible ───────────────────────────
export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<TierModels>;
  embeddingModel?: string;
  organization?: string;
  id?: string;
}

export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = { streaming: true, structured: true, embeddings: true, tools: true, maxContextTokens: 128_000 };
  private readonly baseUrl: string;
  private readonly models: TierModels;
  private readonly embeddingModel: string;

  constructor(private readonly config: OpenAIConfig) {
    this.id = config.id ?? 'openai';
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.models = { cheap: 'gpt-4o-mini', mid: 'gpt-4o-mini', strong: 'gpt-4o', ...config.models };
    this.embeddingModel = config.embeddingModel ?? 'text-embedding-3-small';
  }

  isAvailable(): boolean { return Boolean(this.config.apiKey); }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.organization ? { 'openai-organization': this.config.organization } : {}),
    };
  }

  private body(request: GenerationRequest, stream = false): Record<string, unknown> {
    const model = tierModel(this.models, request.tier);
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({ role: m.role === 'tool' ? 'tool' : m.role, content: m.content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) })),
      temperature: request.temperature ?? 0.4,
      max_tokens: request.maxTokens ?? 1200,
      stream,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      body.tool_choice = 'auto';
    }
    if (request.jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: request.intent ?? 'output', schema: request.jsonSchema, strict: false } };
    }
    return body;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    const response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(this.body(request)), signal: request.signal,
    });
    const data = await response.json() as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function?: { name: string; arguments?: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const choice = data.choices?.[0];
    const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name ?? '',
      arguments: safeParseArgs(call.function?.arguments),
    }));
    return {
      text: choice?.message?.content ?? '',
      toolCalls,
      provider: this.id,
      model: data.model ?? tierModel(this.models, request.tier),
      tier: request.tier ?? 'mid',
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason ?? 'stop',
    };
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const started = Date.now();
    const response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: { ...this.headers(), accept: 'text/event-stream' }, body: JSON.stringify(this.body(request, true)), signal: request.signal,
    }, { retries: 0 });
    if (!response.body) return this.generate(request);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls = new Map<number, ToolCallRequest & { rawArgs: string }>();
    let model = '';
    let finishReason = 'stop';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            model?: string;
            choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
          };
          model = chunk.model ?? model;
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) { text += delta.content; onDelta({ text: delta.content }); }
          for (const call of delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const existing = toolCalls.get(index) ?? { id: call.id ?? newIdFallback(), name: call.function?.name ?? '', arguments: {}, rawArgs: '' };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments) existing.rawArgs += call.function.arguments;
            toolCalls.set(index, existing);
          }
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        } catch { /* keep streaming on a malformed chunk */ }
      }
    }

    const calls: ToolCallRequest[] = [...toolCalls.values()].map((call) => ({ id: call.id, name: call.name, arguments: safeParseArgs(call.rawArgs) }));
    onDelta({ done: true });
    return {
      text, toolCalls: calls, provider: this.id, model: model || tierModel(this.models, request.tier), tier: request.tier ?? 'mid',
      usage: { promptTokens: estimateTokens(request.messages.map((m) => m.content).join('')), completionTokens: estimateTokens(text) },
      latencyMs: Date.now() - started, finishReason,
    };
  }

  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> { return structured(this, request, schema); }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const response = await fetchWithRetry(`${this.baseUrl}/embeddings`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ model: this.embeddingModel, input: texts.slice(0, 100) }),
    });
    const data = await response.json() as { data?: { embedding: number[]; index: number }[] };
    return (data.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

// ─────────────────────────── Anthropic ───────────────────────────
export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<TierModels>;
  version?: string;
  id?: string;
}

export class AnthropicProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = { streaming: false, structured: true, embeddings: false, tools: true, maxContextTokens: 200_000 };
  private readonly baseUrl: string;
  private readonly models: TierModels;

  constructor(private readonly config: AnthropicConfig) {
    this.id = config.id ?? 'anthropic';
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.models = { cheap: 'claude-3-5-haiku-latest', mid: 'claude-sonnet-4-20250514', strong: 'claude-opus-4-20250514', ...config.models };
  }

  isAvailable(): boolean { return Boolean(this.config.apiKey); }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages: { role: 'user' | 'assistant'; content: string }[] = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.role === 'tool' ? `Tool ${m.name ?? 'result'} returned: ${m.content}` : m.content,
      }));

    const body: Record<string, unknown> = {
      model: tierModel(this.models, request.tier),
      max_tokens: request.maxTokens ?? 1500,
      temperature: request.temperature ?? 0.4,
      messages: messages.length ? messages : [{ role: 'user', content: '.' }],
    };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }
    if (request.jsonSchema) {
      body.system = `${system}\n\nRespond with ONLY a JSON object matching this schema:\n${JSON.stringify(request.jsonSchema)}`;
    }

    const response = await fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey, 'anthropic-version': this.config.version ?? '2023-06-01' },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const data = await response.json() as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
      stop_reason?: string;
    };
    const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const toolCalls: ToolCallRequest[] = (data.content ?? [])
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ id: c.id ?? newIdFallback(), name: c.name ?? '', arguments: c.input ?? {} }));
    return {
      text, toolCalls, provider: this.id, model: data.model ?? tierModel(this.models, request.tier), tier: request.tier ?? 'mid',
      usage: { promptTokens: data.usage?.input_tokens ?? 0, completionTokens: data.usage?.output_tokens ?? 0 },
      latencyMs: Date.now() - started, finishReason: data.stop_reason ?? 'stop',
    };
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const result = await this.generate(request);
    if (result.text) {
      for (let i = 0; i < result.text.length; i += 80) onDelta({ text: result.text.slice(i, i + 80) });
    }
    for (const call of result.toolCalls) onDelta({ toolCall: call });
    onDelta({ done: true });
    return result;
  }

  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> { return structured(this, request, schema); }

  async embed(): Promise<number[][]> {
    throw new AppError('unsupported', 'Anthropic does not provide an embeddings API', { userMessage: 'Memory search falls back to keyword retrieval with this provider.' });
  }
}

// ─────────────────────────── Google Gemini ───────────────────────────
export interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<TierModels>;
  embeddingModel?: string;
  id?: string;
}

export class GoogleProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = { streaming: false, structured: true, embeddings: true, tools: true, maxContextTokens: 1_000_000 };
  private readonly baseUrl: string;
  private readonly models: TierModels;
  private readonly embeddingModel: string;

  constructor(private readonly config: GoogleConfig) {
    this.id = config.id ?? 'google';
    this.baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.models = { cheap: 'gemini-2.0-flash', mid: 'gemini-2.0-flash', strong: 'gemini-2.5-pro', ...config.models };
    this.embeddingModel = config.embeddingModel ?? 'text-embedding-004';
  }

  isAvailable(): boolean { return Boolean(this.config.apiKey); }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    const model = tierModel(this.models, request.tier);
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = request.messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.role === 'tool' ? `Tool ${m.name ?? ''} result: ${m.content}` : m.content }],
    }));
    const generationConfig: Record<string, unknown> = { temperature: request.temperature ?? 0.4, maxOutputTokens: request.maxTokens ?? 1500 };
    if (request.jsonSchema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = request.jsonSchema; }

    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (request.tools?.length) {
      body.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
    }

    const response = await fetchWithRetry(`${this.baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal,
    });
    const data = await response.json() as {
      candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => p.text).map((p) => p.text ?? '').join('');
    const toolCalls: ToolCallRequest[] = parts.filter((p) => p.functionCall).map((p) => ({ id: newIdFallback(), name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
    return {
      text, toolCalls, provider: this.id, model, tier: request.tier ?? 'mid',
      usage: { promptTokens: data.usageMetadata?.promptTokenCount ?? 0, completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
      latencyMs: Date.now() - started, finishReason: data.candidates?.[0]?.finishReason ?? 'STOP',
    };
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const result = await this.generate(request);
    if (result.text) for (let i = 0; i < result.text.length; i += 80) onDelta({ text: result.text.slice(i, i + 80) });
    for (const call of result.toolCalls) onDelta({ toolCall: call });
    onDelta({ done: true });
    return result;
  }

  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> { return structured(this, request, schema); }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (const text of texts.slice(0, 50)) {
      const response = await fetchWithRetry(`${this.baseUrl}/models/${this.embeddingModel}:embedContent?key=${encodeURIComponent(this.config.apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: { parts: [{ text }] } }),
      });
      const data = await response.json() as { embedding?: { values?: number[] } };
      out.push(data.embedding?.values ?? []);
    }
    return out;
  }
}

function safeParseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch { return { _raw: raw }; }
}

let counter = 0;
function newIdFallback(): string {
  counter += 1;
  return `call_${Date.now().toString(36)}_${counter}`;
}

export { parseJsonLoose, fetchWithRetry };
