import type { z, ZodTypeAny } from 'zod';

export type ModelTier = 'cheap' | 'mid' | 'strong';

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool name for role='assistant' tool calls, or the tool that produced a role='tool' message. */
  name?: string;
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface GenerationRequest {
  messages: GenerationMessage[];
  tools?: ToolSpec[];
  tier?: ModelTier;
  intent?: string;
  maxTokens?: number;
  temperature?: number;
  /** When set, the provider must return JSON matching this schema. */
  jsonSchema?: JsonSchema;
  /** Optional Zod schema used to validate structured output. */
  validate?: ZodTypeAny;
  signal?: AbortSignal;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GenerationResult {
  text: string;
  toolCalls: ToolCallRequest[];
  provider: string;
  model: string;
  tier: ModelTier;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  finishReason: string;
}

export interface StreamDelta { text?: string; toolCall?: ToolCallRequest; done?: boolean; error?: string }

export interface ProviderCapabilities {
  streaming: boolean;
  structured: boolean;
  embeddings: boolean;
  tools: boolean;
  maxContextTokens: number;
}

/** Provider abstraction (req. 21) — swap OpenAI / Anthropic / Google / local without touching callers. */
export interface AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerationRequest): Promise<GenerationResult>;
  stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult>;
  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
  /** Cheap synchronous check used by the fallback chain (key present, offline ok, etc.). */
  isAvailable(): boolean;
}

// ─────────────────────────── minimal JSON-schema types + zod converter ───────────────────────────
export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean; description?: string }
  | { type: 'array'; items: JsonSchema; description?: string }
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null' }
  | { anyOf: JsonSchema[]; description?: string }
  | { type?: string; description?: string; [key: string]: unknown };

interface ZodDef {
  typeName?: string;
  type?: ZodTypeAny;
  innerType?: ZodTypeAny;
  values?: string[];
  shape?: () => Record<string, ZodTypeAny>;
  options?: ZodTypeAny[];
  schema?: ZodTypeAny;
  checks?: { kind: string; value?: unknown }[];
  description?: string;
}

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Tiny zod → JSON-schema converter covering what the tool definitions use.
 * Avoids an extra dependency and keeps tool specs portable across providers.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const result = convert(schema);
  const description = defOf(schema).description;
  return description ? ({ ...result, description } as JsonSchema) : result;
}

function convert(schema: ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type!) };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: def.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodLiteral':
      return { type: typeof (def as unknown as { value: unknown }).value === 'number' ? 'number' : 'string', enum: [String((def as unknown as { value: unknown }).value)] };
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return zodToJsonSchema(def.innerType!);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return { anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)) };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: true, properties: {} };
    case 'ZodEffects':
      return zodToJsonSchema(def.schema ?? def.innerType!);
    default:
      return { type: 'string' };
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = defOf(schema);
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return true;
  try { return schema.isOptional(); } catch { return false; }
}

/** Rough token estimate (~4 chars/token) used for context budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
