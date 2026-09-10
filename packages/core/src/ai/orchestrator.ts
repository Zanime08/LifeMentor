import { z } from 'zod';
import type { AIProvider, GenerationMessage, GenerationResult, ModelTier, StreamDelta, ToolCallRequest } from './types';
import { zodToJsonSchema, estimateTokens } from './types';
import { ContextEngine, trimHistory, type BuiltContext, type ContextRequest } from './context-engine';
import { ToolRegistry, type ConfirmationRequest, type ToolInvocationContext, type ToolOutcome, type ToolRisk } from './tools';
import { ConversationStore } from './conversation';
import { LocalHeuristicProvider, detectIntent } from './providers/local';
import type { MemoryService } from '../services/memory';
import type { SettingsService } from '../services/settings';
import type { WriteContext } from '../db/repo';
import { AI_WRITE } from '../db/repo';
import type { Memory } from '../domain/types';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';
import { dayKey } from '../util/time';

const log = createLogger('ai');

/**
 * AI Orchestrator (req. 22, 23, 24, 26).
 *
 * One turn = build bounded context → ask the provider → execute the tool calls it
 * asked for (through the registry, never SQL) → feed results back → answer →
 * persist everything → extract durable memories.
 *
 * Guarantees encoded here:
 *  - the loop is bounded (max iterations, token budget, abort signal);
 *  - a destructive or ambiguous tool call stops the loop and becomes a confirmation card;
 *  - a provider outage degrades to the offline heuristic engine instead of failing the user;
 *  - unattended turns (proactive mentor) may only read and notify — never write.
 */

export interface OrchestratorDeps {
  provider: AIProvider;
  tools: ToolRegistry;
  context: ContextEngine;
  memory: MemoryService;
  conversations: ConversationStore;
  settings: SettingsService;
  deviceId: string;
  /** Last-resort engine when the configured provider is unreachable. */
  fallback?: AIProvider;
}

export interface TurnOptions {
  conversationId?: string;
  intent?: string;
  tier?: ModelTier;
  budgetTokens?: number;
  historyLimit?: number;
  /** Confirmation ids the user approved in the UI for this turn. */
  approved?: string[];
  /** Restrict the tools offered to the model. */
  allowedTools?: string[];
  /** Proactive/background turn: read + notify only, no writes without approval. */
  unattended?: boolean;
  maxIterations?: number;
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
  /** Skip memory extraction (e.g. for onboarding interview turns). */
  extractMemories?: boolean;
  write?: WriteContext;
  sections?: ContextRequest['sections'];
  /** Extra instructions appended to the context system message (persona, tone). */
  extraSystem?: string;
}

export interface ToolExecution {
  call: ToolCallRequest;
  outcome: ToolOutcome;
  durationMs: number;
}

export interface TurnResult {
  conversationId: string;
  messageId: string;
  reply: string;
  intent: string;
  provider: string;
  model: string;
  /** True when the answer came from the offline engine rather than a cloud model. */
  offline: boolean;
  degraded: boolean;
  toolCalls: ToolExecution[];
  confirmations: ConfirmationRequest[];
  needsInput: string | null;
  memoriesSaved: Memory[];
  usage: { promptTokens: number; completionTokens: number; iterations: number; latencyMs: number; contextTokens: number };
  context: { included: string[]; dropped: string[]; warnings: string[] };
}

export const MemoryExtractionSchema = z.object({
  memories: z.array(z.object({
    kind: z.enum(['fact', 'preference', 'goal_change', 'decision', 'event', 'insight', 'behavior', 'skill_evidence']),
    content: z.string().min(4).max(600),
    importance: z.number().min(0).max(1).default(0.6),
    confidence: z.enum(['confirmed', 'inferred', 'uncertain']).default('inferred'),
    section: z.string().max(40).optional(),
    tags: z.array(z.string().max(30)).max(8).default([]),
  })).max(8).default([]),
});
export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;
type MemoryExtractionRaw = z.input<typeof MemoryExtractionSchema>;

const MAX_ITERATIONS = 4;
const UNATTENDED_RISKS: ToolRisk[] = ['read'];

export class AIOrchestrator {
  private readonly fallback: AIProvider;

  constructor(private readonly deps: OrchestratorDeps) {
    this.fallback = deps.fallback ?? new LocalHeuristicProvider();
  }

  get provider(): AIProvider { return this.deps.provider; }

  /** Run one conversational turn end-to-end. */
  async chat(userText: string, options: TurnOptions = {}): Promise<TurnResult> {
    const started = Date.now();
    const text = userText.trim();
    if (!text) throw AppError.validation('Message is empty');

    const settings = await this.deps.settings.all();
    const day = dayKey();
    const intent = options.intent ?? detectIntent(text);
    const conversation = options.conversationId
      ? await this.requireConversation(options.conversationId)
      : await this.deps.conversations.resume('mentor');
    const write = options.write ?? AI_WRITE;

    await this.deps.conversations.addUser(conversation.id, text, { actor: 'user', deviceId: this.deps.deviceId });

    const built = await this.deps.context.build({
      query: text, intent, day, budgetTokens: options.budgetTokens ?? settings.ai.context_budget_tokens, sections: options.sections,
    });

    const history = (await this.deps.conversations.history(conversation.id, options.historyLimit ?? 24))
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1) // the message we just stored is re-added below as the live prompt
      .map((m): GenerationMessage => ({ role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user', content: m.content }));

    const messages: GenerationMessage[] = [
      { role: 'system', content: options.extraSystem ? `${built.text}\n\n${options.extraSystem}` : built.text },
      ...trimHistory(history, 1800),
      { role: 'user', content: text },
    ];

    const toolSpecs = this.toolSpecs(options, intent);
    const toolCtx: ToolInvocationContext = {
      write: { ...write, deviceId: this.deps.deviceId },
      day, intent, now: new Date(), approved: options.approved ?? [], language: settings.ai.language,
    };

    let provider = this.deps.provider;
    let degraded = false;
    const executions: ToolExecution[] = [];
    const confirmations: ConfirmationRequest[] = [];
    let needsInput: string | null = null;
    let reply = '';
    let last: GenerationResult | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let iterations = 0;
    const maxIterations = Math.max(1, options.maxIterations ?? MAX_ITERATIONS);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      iterations = iteration + 1;
      if (options.signal?.aborted) throw new AppError('validation', 'Turn aborted', { userMessage: 'Stopped.' });

      let result: GenerationResult;
      const isLast = iteration === maxIterations - 1;
      try {
        result = isLast && options.onDelta && provider.capabilities.streaming
          ? await provider.stream({ messages, tools: toolSpecs, tier: options.tier ?? 'mid', intent, signal: options.signal }, options.onDelta)
          : await provider.generate({ messages, tools: toolSpecs, tier: options.tier ?? 'mid', intent, signal: options.signal });
      } catch (error) {
        if (provider.id === this.fallback.id || options.signal?.aborted) throw error;
        log.warn('provider failed, degrading to offline engine', { provider: provider.id, error: messageOf(error) });
        provider = this.fallback;
        degraded = true;
        result = await provider.generate({ messages, tools: toolSpecs, tier: 'cheap', intent, signal: options.signal });
      }
      last = result;
      promptTokens += result.usage.promptTokens;
      completionTokens += result.usage.completionTokens;

      const calls = result.toolCalls.filter((call) => this.toolAllowed(call.name, call.arguments, toolSpecs, options, executions));
      if (!calls.length) {
        reply = result.text.trim();
        break;
      }

      messages.push({ role: 'assistant', content: result.text || '', name: 'assistant' });
      for (const call of calls) {
        const callStarted = Date.now();
        const outcome = await this.deps.tools.invoke(call.name, call.arguments, toolCtx);
        executions.push({ call, outcome, durationMs: Date.now() - callStarted });
        await this.deps.conversations.addTool(conversation.id, call.name, JSON.stringify({ args: call.arguments, ok: outcome.ok, message: outcome.message }), write);

        if (outcome.confirmation) confirmations.push(outcome.confirmation);
        if (outcome.needsInput && !needsInput) needsInput = outcome.needsInput;

        messages.push({
          role: 'tool',
          name: call.name,
          tool_call_id: call.id,
          content: JSON.stringify({ ok: outcome.ok, message: outcome.message, needs_input: outcome.needsInput ?? null, data: summariseData(outcome.data) }),
        });
      }

      // Anything requiring the user's decision ends the loop: never act on their behalf twice.
      if (confirmations.length || needsInput) {
        reply = composeBlockedReply(confirmations, needsInput, executions, settings.ai.language);
        break;
      }
      if (isLast) {
        reply = result.text.trim() || summariseExecutions(executions, settings.ai.language);
      }
    }

    if (!reply && last) reply = last.text.trim();
    if (!reply) reply = summariseExecutions(executions, settings.ai.language);

    const offline = provider.id === 'local-heuristic' || provider.id.startsWith('local');
    const message = await this.deps.conversations.addAssistant(conversation.id, reply, {
      provider: last?.provider ?? provider.id,
      model: last?.model ?? 'unknown',
      tokens: completionTokens || estimateTokens(reply),
      latencyMs: Date.now() - started,
      // A refused tool call leaves the question on the message: the interface restores it after a
      // restart instead of dropping a decision the user never made (req. 13).
      toolCalls: executions.length
        ? executions.map((e) => ({
          name: e.call.name,
          ok: e.outcome.ok,
          ...(e.outcome.confirmation ? { confirmation: e.outcome.confirmation } : {}),
        }))
        : undefined,
    }, write);

    const memoriesSaved = options.extractMemories === false || !settings.ai.memory_enabled
      ? []
      : await this.extractAndSaveMemories(text, { intent, write, confirmedByUser: true }).catch((error) => {
        log.warn('memory extraction failed', { error: messageOf(error) });
        return [] as Memory[];
      });

    return {
      conversationId: conversation.id,
      messageId: message.id,
      reply,
      intent,
      provider: last?.provider ?? provider.id,
      model: last?.model ?? 'unknown',
      offline,
      degraded,
      toolCalls: executions,
      confirmations,
      needsInput,
      memoriesSaved,
      usage: { promptTokens, completionTokens, iterations, latencyMs: Date.now() - started, contextTokens: built.totalTokens },
      context: { included: built.included, dropped: built.dropped, warnings: built.warnings },
    };
  }

  /**
   * Finish a step the model proposed and the user has now decided about (req. 22–24).
   *
   * Some tools are destructive (`delete_calendar_event`, `cancel_task`, `delete_memory`) or change
   * something the user should see first (raising a task to P0, archiving a goal, saving a confirmed
   * fact). The registry refuses to run them without an approval id and hands the model a question to
   * put to the user. Nothing in the interface ever answered that question, so those tools could
   * never run at all — the user said "да, удали" and the same refusal came back.
   *
   * `resolveConfirmation` executes **the call the model already proposed**, with the user's explicit
   * approval, and records both the tool row and the answer in the conversation, so the next turn
   * knows what happened. The model gets no extra power: the arguments are exactly the ones the user
   * saw before approving.
   *
   * `replyText` is composed by the caller (the interface words it for the reader); the fallback is a
   * neutral English sentence for callers that have no interface — tests, scripts, an API client.
   */
  async resolveConfirmation(
    request: ConfirmationRequest,
    options: { approved: boolean; conversationId: string; replyText?: string; write?: WriteContext },
  ): Promise<{ ok: boolean; tool: string; outcome: ToolOutcome | null; conversationId: string; messageId: string; reply: string }> {
    const conversation = await this.requireConversation(options.conversationId);
    const write = options.write ?? AI_WRITE;
    const settings = await this.deps.settings.all();
    let outcome: ToolOutcome | null = null;

    if (options.approved) {
      const ctx: ToolInvocationContext = {
        write: { ...write, deviceId: this.deps.deviceId },
        // The approval is scoped to exactly this call: the id the registry computed for these
        // arguments, and the tool name (the registry accepts either).
        day: dayKey(), intent: 'approval', now: new Date(), approved: [request.id, request.tool],
        language: settings.ai.language,
      };
      // The arguments come back from the model as JSON; the registry validates them again anyway
      // (a refused confirmation is a normal answer, never an exception).
      const args = (request.args ?? {}) as Record<string, unknown>;
      outcome = await this.deps.tools.invoke(request.tool, args, ctx);
    }

    await this.deps.conversations.addTool(conversation.id, request.tool, JSON.stringify({
      args: request.args, ok: outcome?.ok ?? false, approved: options.approved, message: outcome?.message ?? null,
    }), write);

    const reply = options.replyText?.trim()
      || (options.approved
        ? (outcome?.ok ? `Done: ${request.tool}.` : `That did not work: ${outcome?.message ?? 'unknown reason'}`)
        : `Cancelled: ${request.tool} was not run.`);

    const message = await this.deps.conversations.addAssistant(conversation.id, reply, {
      provider: options.approved ? 'user-approval' : 'user-refusal',
      model: request.tool,
      tokens: estimateTokens(reply),
      latencyMs: 0,
      toolCalls: [{ name: request.tool, ok: outcome?.ok ?? false }],
    }, write);

    return { ok: outcome?.ok ?? false, tool: request.tool, outcome, conversationId: conversation.id, messageId: message.id, reply };
  }

  /**
   * Structured request (no tools): planning proposals, reviews, news structuring,
   * interview questions. Validated against a zod schema with one repair attempt
   * handled by the provider layer.
   */
  async structured<T>(intent: string, instruction: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, options: {
    tier?: ModelTier; context?: ContextRequest; extra?: Record<string, unknown>; signal?: AbortSignal; maxTokens?: number;
  } = {}): Promise<{ data: T; provider: string; model: string; usage: { promptTokens: number; completionTokens: number }; offline: boolean }> {
    const built = options.context ? await this.deps.context.build({ ...options.context, intent }) : await this.deps.context.build({ intent, query: instruction });
    const messages: GenerationMessage[] = [
      { role: 'system', content: `${built.text}\n\nRespond with JSON only. Never invent data that is not in the context above.` },
      { role: 'user', content: options.extra ? `${instruction}\n\nInput data: ${JSON.stringify(options.extra)}` : instruction },
    ];
    const request = {
      messages, intent, tier: options.tier ?? 'mid', jsonSchema: zodToJsonSchema(schema), maxTokens: options.maxTokens ?? 1200, signal: options.signal,
    };
    try {
      const data = await this.deps.provider.generateStructured(request, schema as z.ZodType<T>);
      const usage = { promptTokens: estimateTokens(messages.map((m) => m.content).join('')), completionTokens: estimateTokens(JSON.stringify(data)) };
      return { data, provider: this.deps.provider.id, model: this.deps.provider.id, usage, offline: this.deps.provider.id.startsWith('local') };
    } catch (error) {
      if (this.deps.provider.id === this.fallback.id) throw error;
      log.warn('structured call failed, degrading', { intent, error: messageOf(error) });
      const data = await this.fallback.generateStructured({ ...request, tier: 'cheap' }, schema as z.ZodType<T>);
      return { data, provider: this.fallback.id, model: 'heuristic-v1', usage: { promptTokens: 0, completionTokens: 0 }, offline: true };
    }
  }

  /**
   * Extract durable memories from a user statement and store them.
   * User statements are stored as confirmed; anything the model inferred is
   * stored as inferred and flagged for confirmation (req. 52, 53).
   */
  async extractAndSaveMemories(text: string, options: { intent?: string; write?: WriteContext; confirmedByUser?: boolean; limit?: number } = {}): Promise<Memory[]> {
    if (text.trim().length < 8) return [];
    const settings = await this.deps.settings.all();
    if (!settings.ai.memory_enabled) return [];

    const extracted = await this.runExtraction(text, options.intent);
    const saved: Memory[] = [];
    for (const candidate of extracted.memories.slice(0, options.limit ?? 6)) {
      const content = candidate.content.trim();
      if (content.length < 6) continue;
      if (await this.isDuplicate(content)) continue;
      const confirmed = options.confirmedByUser && candidate.confidence === 'confirmed';
      const memory = await this.deps.memory.save({
        kind: candidate.kind,
        content,
        importance: clamp01(candidate.importance ?? 0.6),
        confidence: confirmed ? 'confirmed' : candidate.confidence === 'confirmed' ? 'inferred' : candidate.confidence,
        source: confirmed ? 'user_provided' : 'ai_inferred',
        section: candidate.section ?? null,
        tags: candidate.tags ?? [],
        needs_confirmation: !confirmed && settings.ai.confirm_fact_changes,
        provenance: [{ source_type: 'conversation', note: options.intent ?? 'chat' }],
      }, options.write ?? { actor: 'ai', deviceId: this.deps.deviceId });
      saved.push(memory);
    }
    if (saved.length) log.debug('memories saved', { count: saved.length });
    return saved;
  }

  private async runExtraction(text: string, intent?: string): Promise<MemoryExtraction> {
    const schema = MemoryExtractionSchema;
    const request = {
      messages: [
        { role: 'system' as const, content: 'Extract only durable facts the user stated about themselves: identity, situation, goals, preferences, constraints, deadlines, decisions, skill evidence. Ignore small talk, mood and one-off questions. Write each memory in the third person ("The user ..."). Mark anything you inferred as inferred.' },
        { role: 'user' as const, content: text },
      ],
      intent: 'extract_memories',
      tier: 'cheap' as ModelTier,
      jsonSchema: zodToJsonSchema(schema),
      maxTokens: 600,
    };
    // The provider validates against the schema; re-parsing applies defaults and
    // guarantees the strongly-typed output shape regardless of provider.
    const validator = schema as unknown as z.ZodType<MemoryExtractionRaw>;
    try {
      const raw = await this.deps.provider.generateStructured(request, validator);
      return schema.parse(raw);
    } catch (error) {
      void intent;
      log.debug('memory extraction degraded to offline engine', { error: messageOf(error) });
      const raw = await this.fallback.generateStructured(request, validator);
      return schema.parse(raw);
    }
  }

  /**
   * A memory is a duplicate when the same words are already stored, or when one
   * text contains the other with high token overlap ("The user is a backend
   * developer" already covers "backend developer"). Thresholds are deliberately
   * conservative: dropping a real fact is worse than storing a near-duplicate.
   */
  private async isDuplicate(content: string): Promise<boolean> {
    const needle = normaliseText(content);
    if (!needle) return true;
    const similar = await this.deps.memory.search(content, { limit: 5, includeUnconfirmed: true });
    for (const memory of similar) {
      const existing = normaliseText(memory.content);
      if (!existing) continue;
      if (existing === needle) return true;
      const contained = existing.includes(needle) || needle.includes(existing);
      const shared = overlap(existing, needle);
      if (contained && shared >= 0.6) return true;
      if (shared >= 0.85 && memory.score >= 0.7) return true;
    }
    return false;
  }

  private toolSpecs(options: TurnOptions, intent: string) {
    const names = options.allowedTools ?? (options.unattended ? this.deps.tools.byRisk('read').map((t) => t.name).concat('send_notification') : undefined);
    const specs = this.deps.tools.specs(names);
    void intent;
    return specs;
  }

  /**
   * Guard rails for a requested call: it must exist, it must have been offered to
   * the model, an unattended turn may not write, and the identical call must not
   * be repeated (bounded loop even if a model insists).
   */
  private toolAllowed(
    name: string,
    args: Record<string, unknown>,
    offered: { name: string }[],
    options: TurnOptions,
    previous: ToolExecution[],
  ): boolean {
    const tool = this.deps.tools.get(name);
    if (!tool) return false;
    if (offered.length && !offered.some((spec) => spec.name === name)) return false;
    if (options.unattended && !UNATTENDED_RISKS.includes(tool.risk) && name !== 'send_notification') return false;
    const signature = `${name}:${stable(args)}`;
    return !previous.some((p) => `${p.call.name}:${stable(p.call.arguments)}` === signature);
  }

  private async requireConversation(id: string) {
    const conversation = await this.deps.conversations.get(id);
    if (!conversation) throw AppError.notFound('conversation', id);
    return conversation;
  }
}

function stable(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Tool payloads are trimmed before they go back into the prompt (token budget). */
function summariseData(data: unknown, maxTokens = 500): unknown {
  if (data === undefined || data === null) return data;
  const json = JSON.stringify(data);
  if (estimateTokens(json) <= maxTokens) return data;
  if (Array.isArray(data)) return { truncated: true, count: data.length, items: data.slice(0, 8) };
  return { truncated: true, preview: json.slice(0, maxTokens * 4) };
}

function composeBlockedReply(confirmations: ConfirmationRequest[], needsInput: string | null, executions: ToolExecution[], language: string): string {
  const done = executions.filter((e) => e.outcome.ok).map((e) => e.outcome.message);
  const parts: string[] = [];
  if (done.length) parts.push(done.join('\n'));
  if (confirmations.length) {
    const ru = language.toLowerCase().startsWith('ru');
    parts.push(ru
      ? `Нужно подтверждение:\n${confirmations.map((c) => `• ${c.detail}`).join('\n')}`
      : `I need your confirmation before acting:\n${confirmations.map((c) => `• ${c.detail}`).join('\n')}`);
  }
  if (needsInput) parts.push(needsInput);
  return parts.join('\n\n');
}

function summariseExecutions(executions: ToolExecution[], language: string): string {
  if (!executions.length) return language.toLowerCase().startsWith('ru') ? 'Готово.' : 'Done.';
  return executions.map((e) => (e.outcome.ok ? e.outcome.message : `• ${e.outcome.message}`)).join('\n');
}

function normaliseText(value: string): string {
  return value.toLowerCase().replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function overlap(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter((w) => w.length > 2));
  const setB = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!setA.size || !setB.size) return 0;
  let hits = 0;
  for (const word of setA) if (setB.has(word)) hits += 1;
  return hits / Math.max(setA.size, setB.size);
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5)); }

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type { BuiltContext };
