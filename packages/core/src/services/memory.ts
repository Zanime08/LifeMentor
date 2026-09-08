import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { Confidence, FactSource, Memory, MemoryKind } from '../domain/types';
import { newId } from '../util/id';
import { addDays, nowIso } from '../util/time';
import { AppError } from '../util/result';

export const SaveMemorySchema = z.object({
  kind: z.enum(['fact', 'preference', 'goal_change', 'decision', 'event', 'insight', 'behavior', 'skill_evidence']),
  content: z.string().trim().min(1).max(4000),
  section: z.string().max(60).nullish(),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.enum(['confirmed', 'inferred', 'uncertain']).default('confirmed'),
  source: z.enum(['user_provided', 'ai_inferred', 'system_observed']).default('user_provided'),
  entity_type: z.string().max(40).nullish(),
  entity_id: z.string().max(80).nullish(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  valid_from: z.string().nullish(),
  valid_until: z.string().nullish(),
  needs_confirmation: z.boolean().default(false),
  provenance: z.array(z.object({ source_type: z.string().max(40), source_id: z.string().max(80).nullish(), note: z.string().max(500).nullish() })).max(10).default([]),
  /** Replaces an older memory instead of duplicating it. */
  supersedes: z.string().nullish(),
});
export type SaveMemoryInput = z.input<typeof SaveMemorySchema>;

export interface Embedder { embed(texts: string[]): Promise<number[][]> }

export interface ScoredMemory extends Memory {
  score: number;
  matched_by: ('semantic' | 'keyword' | 'recency' | 'importance')[];
  tags_list: string[];
}

export interface MemorySearchOptions {
  limit?: number;
  kinds?: MemoryKind[];
  section?: string;
  minImportance?: number;
  includeUnconfirmed?: boolean;
  asOf?: Date;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'i', 'you', 'my', 'your', 'it', 'this', 'that', 'at', 'as', 'by', 'from', 'about', 'into', 'me', 'we', 'they']);

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9а-яё]+/iu).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Long-term memory (req. 5, 26, 28, 53, 99).
 *
 * Retrieval is hybrid:
 *  - structured filters (kind / section / entity / validity) → SQL, indexed;
 *  - semantic similarity when an embedder is configured, otherwise keyword overlap;
 *  - importance + recency weighting, with superseded memories excluded.
 *
 * Nothing is deleted silently: replaced memories keep `superseded_by` and remain auditable.
 */
export class MemoryService {
  private embedder: Embedder | null;

  constructor(private readonly repos: Repos, options: { embedder?: Embedder } = {}) {
    this.embedder = options.embedder ?? null;
  }

  setEmbedder(embedder: Embedder | null): void { this.embedder = embedder; }

  async save(input: SaveMemoryInput, ctx: WriteContext = USER_WRITE): Promise<Memory> {
    const parsed = SaveMemorySchema.parse(input);

    // Deduplicate: an identical active memory is updated, not duplicated.
    const existing = await this.repos.memories.findOne({ content: parsed.content, deleted: 0, superseded_by: null });
    if (existing) {
      const updated = await this.repos.memories.update(existing.id, {
        importance: Math.max(Number(existing.importance), parsed.importance),
        confidence: parsed.source === 'user_provided' ? 'confirmed' : existing.confidence,
        updated_at: nowIso(),
      } as never, { ...ctx, reason: 'memory reinforced' });
      await this.addProvenance(updated!.id, parsed.provenance, ctx);
      return updated!;
    }

    let embedding: string | null = null;
    if (this.embedder) {
      try {
        const [vector] = await this.embedder.embed([parsed.content]);
        if (vector?.length) embedding = JSON.stringify(vector);
      } catch { /* embeddings are an optimisation, never a blocker */ }
    }

    const memory = await this.repos.memories.insert({
      id: newId('memory'),
      kind: parsed.kind,
      section: parsed.section ?? null,
      content: parsed.content,
      importance: parsed.importance,
      confidence: parsed.confidence,
      source: parsed.source,
      entity_type: parsed.entity_type ?? null,
      entity_id: parsed.entity_id ?? null,
      tags: JSON.stringify(parsed.tags),
      embedding,
      valid_from: parsed.valid_from ?? nowIso(),
      valid_until: parsed.valid_until ?? null,
      superseded_by: null,
      needs_confirmation: parsed.needs_confirmation || parsed.source === 'ai_inferred' ? 1 : 0,
      use_count: 0,
      last_used_at: null,
    } as never, { ...ctx, reason: 'memory saved' });

    await this.addProvenance(memory.id, parsed.provenance, ctx);

    if (parsed.supersedes) await this.supersede(parsed.supersedes, memory.id, 'replaced by newer memory', ctx);
    return memory;
  }

  private async addProvenance(memoryId: string, provenance: SaveMemoryInput['provenance'], ctx: WriteContext): Promise<void> {
    for (const entry of provenance ?? []) {
      await this.repos.memorySources.insert({
        id: newId(), memory_id: memoryId, source_type: entry.source_type,
        source_id: entry.source_id ?? null, note: entry.note ?? null, created_at: nowIso(),
      } as never, ctx);
    }
  }

  async update(id: string, patch: Partial<{ content: string; importance: number; confidence: Confidence; section: string; tags: string[]; valid_until: string | null; needs_confirmation: boolean }>, ctx: WriteContext = USER_WRITE): Promise<Memory> {
    const record: Record<string, unknown> = {};
    if (patch.content !== undefined) record.content = patch.content;
    if (patch.importance !== undefined) record.importance = patch.importance;
    if (patch.confidence !== undefined) record.confidence = patch.confidence;
    if (patch.section !== undefined) record.section = patch.section;
    if (patch.tags !== undefined) record.tags = JSON.stringify(patch.tags);
    if (patch.valid_until !== undefined) record.valid_until = patch.valid_until;
    if (patch.needs_confirmation !== undefined) record.needs_confirmation = patch.needs_confirmation ? 1 : 0;
    const updated = await this.repos.memories.update(id, record as never, { ...ctx, reason: 'memory updated' });
    if (!updated) throw AppError.notFound('memory', id);
    if (patch.content && this.embedder) {
      try {
        const [vector] = await this.embedder.embed([patch.content]);
        if (vector?.length) await this.repos.memories.update(id, { embedding: JSON.stringify(vector) } as never, { ...ctx, audit: false });
      } catch { /* ignore */ }
    }
    return updated;
  }

  /** Mark a memory as replaced by another one — the old row stays for audit. */
  async supersede(oldId: string, newIdValue: string, reason: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.memories.update(oldId, { superseded_by: newIdValue, valid_until: nowIso() } as never, { ...ctx, reason: `superseded: ${reason}` });
  }

  async remove(id: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const memory = await this.repos.memories.byId(id);
    if (!memory) return false;
    await this.repos.memories.softDelete(id, { ...ctx, reason: 'memory deleted by user' });
    return true;
  }

  async confirm(id: string, ctx: WriteContext = USER_WRITE): Promise<Memory> {
    const updated = await this.repos.memories.update(id, { confidence: 'confirmed', needs_confirmation: 0, source: 'user_provided' } as never, { ...ctx, reason: 'memory confirmed by user' });
    if (!updated) throw AppError.notFound('memory', id);
    return updated;
  }

  async markUncertain(id: string, note?: string, ctx: WriteContext = USER_WRITE): Promise<Memory> {
    const updated = await this.repos.memories.update(id, { confidence: 'uncertain', needs_confirmation: 1 } as never, { ...ctx, reason: note ?? 'marked uncertain by user' });
    if (!updated) throw AppError.notFound('memory', id);
    return updated;
  }

  async get(id: string): Promise<Memory | null> { return (await this.repos.memories.byId(id)) ?? null; }

  async list(options: MemorySearchOptions & { needsConfirmation?: boolean; source?: FactSource } = {}): Promise<Memory[]> {
    const where: Record<string, unknown> = { superseded_by: null };
    if (options.kinds?.length) where.kind = { op: 'in', value: options.kinds };
    if (options.section) where.section = options.section;
    if (options.minImportance !== undefined) where.importance = { op: 'gte', value: options.minImportance };
    if (options.needsConfirmation) where.needs_confirmation = 1;
    if (options.source) where.source = options.source;
    if (!options.includeUnconfirmed) where.confidence = { op: 'in', value: ['confirmed', 'inferred'] };
    return this.repos.memories.find(where as never, { orderBy: { importance: 'desc', updated_at: 'desc' }, limit: options.limit ?? 200 });
  }

  async byEntity(entityType: string, entityId: string, limit = 20): Promise<Memory[]> {
    return this.repos.memories.find({ entity_type: entityType, entity_id: entityId, superseded_by: null }, { orderBy: { importance: 'desc', updated_at: 'desc' }, limit });
  }

  /** Hybrid retrieval used by the Context Engine and the Mentor. */
  async search(query: string, options: MemorySearchOptions = {}): Promise<ScoredMemory[]> {
    const asOf = options.asOf ?? new Date();
    const candidates = await this.repos.memories.find(
      { superseded_by: null, ...(options.kinds?.length ? { kind: { op: 'in', value: options.kinds } } : {}), ...(options.section ? { section: options.section } : {}) },
      { orderBy: { importance: 'desc', updated_at: 'desc' }, limit: 400 },
    );
    if (!candidates.length) return [];

    const queryTokens = tokenize(query);
    let queryVector: number[] | null = null;
    if (this.embedder && query.trim().length > 3) {
      try { const [v] = await this.embedder.embed([query]); queryVector = v?.length ? v : null; } catch { queryVector = null; }
    }

    const scored: ScoredMemory[] = [];
    for (const memory of candidates) {
      if (memory.valid_until && memory.valid_until < asOf.toISOString() && memory.kind !== 'event') continue;
      if (!options.includeUnconfirmed && memory.confidence === 'uncertain') continue;
      if (options.minImportance !== undefined && Number(memory.importance) < options.minImportance) continue;

      const matchedBy: ScoredMemory['matched_by'] = [];
      let similarity = 0;
      if (queryVector && memory.embedding) {
        try {
          const vector = JSON.parse(memory.embedding) as number[];
          similarity = cosine(queryVector, vector);
          if (similarity > 0.25) matchedBy.push('semantic');
        } catch { /* ignore malformed vector */ }
      }
      const tokens = tokenize(`${memory.content} ${(parseJson<string[]>(memory.tags, []) ?? []).join(' ')} ${memory.section ?? ''}`);
      const overlap = queryTokens.length ? queryTokens.filter((t) => tokens.includes(t)).length / queryTokens.length : 0;
      if (overlap > 0) matchedBy.push('keyword');

      const ageDays = Math.max(0, (asOf.getTime() - new Date(memory.updated_at).getTime()) / 86_400_000);
      const recency = 1 / (1 + ageDays / 60);
      const importance = Number(memory.importance ?? 0.5);
      const usage = Math.min(1, Number(memory.use_count ?? 0) / 10);

      const score = 0.5 * Math.max(similarity, overlap) + 0.22 * importance + 0.18 * recency + 0.1 * usage;
      if (score > 0.02) {
        matchedBy.push('importance', 'recency');
        scored.push({ ...memory, score: Number(score.toFixed(4)), matched_by: [...new Set(matchedBy)], tags_list: parseJson<string[]>(memory.tags, []) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, options.limit ?? 8);
    await this.touch(top.map((m) => m.id));
    return top;
  }

  /** Record that memories were used to build a context — feeds recency/usage weighting. */
  async touch(ids: string[]): Promise<void> {
    for (const id of ids) {
      const memory = await this.repos.memories.byId(id);
      if (!memory) continue;
      await this.repos.memories.update(id, { use_count: Number(memory.use_count ?? 0) + 1, last_used_at: nowIso() } as never, { actor: 'system', audit: false, sync: false });
    }
  }

  /** Text block for the AI context packet. */
  async contextText(query: string, limit = 8): Promise<string> {
    const memories = await this.search(query, { limit });
    if (!memories.length) {
      const fallback = await this.list({ limit, minImportance: 0.6 });
      return fallback.map((m) => `- ${m.content}`).join('\n');
    }
    return memories.map((m) => {
      const tag = m.confidence === 'confirmed' ? '' : m.source === 'ai_inferred' ? ' [assumption]' : ' [observed]';
      return `- ${m.content}${tag}`;
    }).join('\n');
  }

  /** Memory Viewer data (req. 53). */
  async viewerData(): Promise<{
    facts: Memory[]; preferences: Memory[]; goals: Memory[]; insights: Memory[]; events: Memory[];
    assumptions: Memory[]; needs_confirmation: Memory[]; total: number;
  }> {
    const all = await this.repos.memories.find({ superseded_by: null }, { orderBy: { importance: 'desc', updated_at: 'desc' }, limit: 2000 });
    return {
      facts: all.filter((m) => m.kind === 'fact'),
      preferences: all.filter((m) => m.kind === 'preference'),
      goals: all.filter((m) => m.kind === 'goal_change' || m.kind === 'decision'),
      insights: all.filter((m) => m.kind === 'insight' || m.kind === 'behavior'),
      events: all.filter((m) => m.kind === 'event'),
      assumptions: all.filter((m) => m.source === 'ai_inferred'),
      needs_confirmation: all.filter((m) => m.needs_confirmation === 1),
      total: all.length,
    };
  }

  async stats(): Promise<{ total: number; by_kind: Record<string, number>; by_source: Record<string, number>; needs_confirmation: number; superseded: number }> {
    const all = await this.repos.memories.find({}, { limit: 5000, includeDeleted: true });
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const m of all) {
      if (m.deleted) continue;
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      bySource[m.source] = (bySource[m.source] ?? 0) + 1;
    }
    return {
      total: all.filter((m) => !m.deleted).length,
      by_kind: byKind,
      by_source: bySource,
      needs_confirmation: all.filter((m) => !m.deleted && m.needs_confirmation === 1).length,
      superseded: all.filter((m) => !m.deleted && m.superseded_by).length,
    };
  }

  /** Retention policy from Privacy settings (derived cleanup, never touches confirmed facts by default). */
  async prune(days: number | null, options: { keepConfirmed?: boolean } = {}): Promise<number> {
    if (!days || days <= 0) return 0;
    const cutoff = addDays(new Date(), -days).toISOString();
    const stale = await this.repos.memories.find({ updated_at: { op: 'lt', value: cutoff }, importance: { op: 'lt', value: 0.4 } }, { limit: 5000 });
    let removed = 0;
    for (const memory of stale) {
      if (options.keepConfirmed !== false && memory.confidence === 'confirmed' && memory.source === 'user_provided') continue;
      if (memory.kind === 'goal_change' || memory.kind === 'decision') continue; // evolution history is kept
      await this.repos.memories.softDelete(memory.id, { actor: 'system', reason: 'memory retention policy' });
      removed += 1;
    }
    return removed;
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
