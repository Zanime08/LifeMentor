import type { z } from 'zod';
import type { AIProvider, GenerationRequest, GenerationResult, ProviderCapabilities, StreamDelta } from '../types';
import { AppError } from '../../util/result';
import { createLogger } from '../../util/logging';
import { LocalHeuristicProvider } from './local';
import { GatewayProvider, type GatewayConfig } from './gateway';
import { AnthropicProvider, GoogleProvider, OpenAIProvider, type AnthropicConfig, type GoogleConfig, type OpenAIConfig } from './http';

const log = createLogger('ai');

export type ProviderKind = 'local' | 'gateway' | 'openai' | 'anthropic' | 'google';

export interface ProviderConfig {
  kind: ProviderKind;
  /** Optional display id, defaults to the kind. */
  id?: string;
  openai?: OpenAIConfig;
  anthropic?: AnthropicConfig;
  google?: GoogleConfig;
  gateway?: GatewayConfig;
  /** Generic overrides for openai-compatible endpoints (LM Studio, Ollama, vLLM). */
  baseUrl?: string;
  apiKey?: string;
  models?: Partial<{ cheap: string; mid: string; strong: string }>;
}

/** Builds a provider from configuration. No network calls happen here. */
export function createAIProvider(config: ProviderConfig): AIProvider {
  switch (config.kind) {
    case 'local':
      return new LocalHeuristicProvider({ id: config.id });
    case 'gateway': {
      if (!config.gateway) throw new AppError('validation', 'gateway provider needs a gateway config');
      return new GatewayProvider({ ...config.gateway, id: config.id });
    }
    case 'openai': {
      const openai = config.openai ?? { apiKey: config.apiKey ?? '', baseUrl: config.baseUrl, models: config.models };
      if (!openai.apiKey) throw new AppError('validation', 'OpenAI provider needs an API key');
      return new OpenAIProvider({ ...openai, id: config.id });
    }
    case 'anthropic': {
      const anthropic = config.anthropic ?? { apiKey: config.apiKey ?? '', baseUrl: config.baseUrl, models: config.models };
      if (!anthropic.apiKey) throw new AppError('validation', 'Anthropic provider needs an API key');
      return new AnthropicProvider({ ...anthropic, id: config.id });
    }
    case 'google': {
      const google = config.google ?? { apiKey: config.apiKey ?? '', baseUrl: config.baseUrl, models: config.models };
      if (!google.apiKey) throw new AppError('validation', 'Google provider needs an API key');
      return new GoogleProvider({ ...google, id: config.id });
    }
    default:
      throw new AppError('validation', `Unknown AI provider kind: ${String(config.kind)}`);
  }
}

/** Builds a chain: first working provider answers; later ones are fallbacks. */
export function createProviderChain(configs: ProviderConfig[]): AIProvider {
  const providers = configs.map(createAIProvider).filter((p) => p.isAvailable());
  if (!providers.length) return new LocalHeuristicProvider();
  if (providers.length === 1) return providers[0];
  return new FallbackProvider(providers);
}

/**
 * Tries providers in order. A cloud outage therefore degrades to the local
 * engine instead of breaking the app (requirement 26: always usable offline).
 */
export class FallbackProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  lastUsed: string | null = null;

  constructor(private readonly providers: AIProvider[]) {
    this.id = `fallback(${providers.map((p) => p.id).join('→')})`;
    this.capabilities = providers.reduce<ProviderCapabilities>(
      (acc, p) => ({
        streaming: acc.streaming || p.capabilities.streaming,
        structured: acc.structured || p.capabilities.structured,
        embeddings: acc.embeddings || p.capabilities.embeddings,
        tools: acc.tools || p.capabilities.tools,
        maxContextTokens: Math.max(acc.maxContextTokens, p.capabilities.maxContextTokens ?? 0),
      }),
      { streaming: false, structured: false, embeddings: false, tools: false, maxContextTokens: 0 },
    );
  }

  isAvailable(): boolean { return this.providers.some((p) => p.isAvailable()); }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    return this.run((provider) => provider.generate(request), 'generate', request);
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    return this.run((provider) => provider.stream(request, onDelta), 'stream', request);
  }

  async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      if (!provider.capabilities.structured && provider.id !== 'local-heuristic') continue;
      try {
        return await provider.generateStructured(request, schema);
      } catch (error) {
        lastError = error;
        log.warn('structured generation failed, falling back', { provider: provider.id, message: messageOf(error) });
      }
    }
    throw lastError ?? new AppError('provider', 'No AI provider available');
  }

  async embed(texts: string[]): Promise<number[][]> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      if (!provider.isAvailable() || !provider.capabilities.embeddings) continue;
      try { return await provider.embed(texts); } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    // Nobody supports embeddings: hash-embed locally so memory search still works.
    return new LocalHeuristicProvider().embed(texts);
  }

  private async run<T>(fn: (provider: AIProvider) => Promise<T>, op: string, request: GenerationRequest): Promise<T> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      try {
        const result = await fn(provider);
        this.lastUsed = provider.id;
        return result;
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted) throw error;
        log.warn('provider call failed, trying next', { op, provider: provider.id, message: messageOf(error) });
      }
    }
    throw lastError ?? new AppError('provider', 'No AI provider available');
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export { LocalHeuristicProvider, GatewayProvider, OpenAIProvider, AnthropicProvider, GoogleProvider };
export type { GatewayConfig, OpenAIConfig, AnthropicConfig, GoogleConfig };
