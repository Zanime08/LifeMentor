import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { AI_WRITE, USER_WRITE } from '../db/repo';
import type { Conversation, Message } from '../domain/types';
import { newId } from '../util/id';
import { addDays, dayKey, nowIso } from '../util/time';
import { estimateTokens } from './types';

/**
 * Conversation persistence (req. 24).
 *
 * Messages live in SQLite like everything else: they survive a crash, they sync
 * between devices, and they are the audit trail of what the AI said and which
 * tools it ran (provider, model, tokens, latency per message).
 */
export class ConversationStore {
  constructor(private readonly repos: Repos, private readonly deviceId: string) {}

  async start(kind: Conversation['kind'], title: string | null = null, ctx: WriteContext = USER_WRITE): Promise<Conversation> {
    return this.repos.conversations.insert({
      id: newId('conversation'),
      title,
      kind,
      summary: null,
      started_at: nowIso(),
      last_message_at: null,
      message_count: 0,
      tokens_total: 0,
    } as never, { ...ctx, deviceId: this.deviceId });
  }

  async get(id: string): Promise<Conversation | null> { return (await this.repos.conversations.byId(id)) ?? null; }

  async latest(kind?: Conversation['kind']): Promise<Conversation | null> {
    const row = await this.repos.conversations.findOne(
      kind ? { kind } : {},
      { orderBy: { last_message_at: 'desc', started_at: 'desc' }, limit: 1 },
    );
    return row ?? null;
  }

  /** Continue the most recent conversation of this kind unless it went idle. */
  async resume(kind: Conversation['kind'], maxIdleMinutes = 180): Promise<Conversation> {
    const latest = await this.latest(kind);
    if (latest) {
      const anchor = latest.last_message_at ?? latest.started_at;
      const idle = (Date.now() - new Date(anchor).getTime()) / 60000;
      if (idle <= maxIdleMinutes && dayKey(new Date(anchor)) === dayKey()) return latest;
    }
    return this.start(kind);
  }

  async list(limit = 30): Promise<Conversation[]> {
    return this.repos.conversations.find({}, { orderBy: { started_at: 'desc' }, limit });
  }

  async addUser(conversationId: string, content: string, ctx: WriteContext = USER_WRITE): Promise<Message> {
    return this.append(conversationId, { role: 'user', content }, ctx);
  }

  async addAssistant(
    conversationId: string,
    content: string,
    meta: { provider?: string; model?: string; tokens?: number; latencyMs?: number; toolCalls?: unknown } = {},
    ctx: WriteContext = AI_WRITE,
  ): Promise<Message> {
    return this.append(conversationId, {
      role: 'assistant',
      content,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      tokens: meta.tokens ?? estimateTokens(content),
      latency_ms: meta.latencyMs ?? null,
      tool_calls: meta.toolCalls ? JSON.stringify(meta.toolCalls) : null,
    }, ctx);
  }

  /** Tool executions are stored as messages so a turn is fully auditable. */
  async addTool(conversationId: string, toolName: string, content: string, ctx: WriteContext = AI_WRITE): Promise<Message> {
    return this.append(conversationId, { role: 'tool', content, tool_name: toolName }, ctx);
  }

  private async append(conversationId: string, fields: Partial<Message>, ctx: WriteContext): Promise<Message> {
    const content = fields.content ?? '';
    return this.repos.db.transaction(async () => {
      const message = await this.repos.messages.insert({
        id: newId('message'),
        conversation_id: conversationId,
        role: fields.role ?? 'user',
        content,
        tool_calls: fields.tool_calls ?? null,
        tool_name: fields.tool_name ?? null,
        provider: fields.provider ?? null,
        model: fields.model ?? null,
        tokens: fields.tokens ?? estimateTokens(content),
        latency_ms: fields.latency_ms ?? null,
      } as never, { ...ctx, deviceId: this.deviceId });

      const conversation = await this.repos.conversations.byId(conversationId);
      if (conversation) {
        await this.repos.conversations.update(conversationId, {
          message_count: (conversation.message_count ?? 0) + 1,
          tokens_total: (conversation.tokens_total ?? 0) + (message.tokens ?? 0),
          last_message_at: nowIso(),
          title: conversation.title ?? (message.role === 'user' ? content.slice(0, 60) : null),
        } as never, { ...ctx, deviceId: this.deviceId });
      }
      return message;
    }, 'conversation.append');
  }

  async history(conversationId: string, limit = 30): Promise<Message[]> {
    const rows = await this.repos.messages.find({ conversation_id: conversationId }, { orderBy: { created_at: 'desc', id: 'desc' }, limit });
    return rows.reverse();
  }

  async setTitle(conversationId: string, title: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.conversations.update(conversationId, { title } as never, { ...ctx, deviceId: this.deviceId });
  }

  async setSummary(conversationId: string, summary: string, ctx: WriteContext = AI_WRITE): Promise<void> {
    await this.repos.conversations.update(conversationId, { summary } as never, { ...ctx, deviceId: this.deviceId });
  }

  /** Delete conversations and their messages older than N days (privacy, req. 55). */
  async prune(days = 120): Promise<number> {
    const cutoff = addDays(new Date(), -days).toISOString();
    const result = await this.repos.db.run(
      'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE started_at < ?)',
      [cutoff],
    );
    await this.repos.db.run('DELETE FROM conversations WHERE started_at < ?', [cutoff]);
    return result.changes ?? 0;
  }
}
