import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { NewsCategory, NewsItem, NewsSource, NewsUrgency } from '../domain/types';
import { NEWS_CATEGORIES } from '../domain/types';
import type { ProfileService } from './profile';
import type { SettingsService } from './settings';
import { newId } from '../util/id';
import { addMinutes, dayKey, daysUntil, nowIso, relativeDayLabel } from '../util/time';

export const NewsItemInput = z.object({
  source_id: z.string().nullish(),
  external_id: z.string().nullish(),
  url: z.string().nullish(),
  title: z.string().min(1).max(500),
  summary: z.string().nullish(),
  what_happened: z.string().nullish(),
  why_it_matters: z.string().nullish(),
  context: z.string().nullish(),
  impact: z.string().nullish(),
  category: z.enum(NEWS_CATEGORIES as [NewsCategory, ...NewsCategory[]]).default('world'),
  urgency: z.enum(['urgent', 'digest', 'none']).default('digest'),
  published_at: z.string().nullish(),
  relevance: z.number().min(0).max(1).default(0),
  structured: z.boolean().default(false),
});
export type NewsItemInput = z.input<typeof NewsItemInput>;

export interface DigestItem {
  id: string;
  title: string;
  url: string | null;
  category: NewsCategory;
  urgency: NewsUrgency;
  published_at: string | null;
  what_happened: string | null;
  why_it_matters: string | null;
  context: string | null;
  impact: string | null;
  source_name: string | null;
  relevance: number;
}

export interface DailyDigest {
  day: string;
  items: DigestItem[];
  text: string;
  generated_at: string;
}

/**
 * News (req. 47, 48). Fetching happens on the server (sources, dedupe, structuring);
 * the client stores items locally so the feed and the digest are readable offline,
 * and re-ranks them against the user's own interests and goals.
 */
export class NewsService {
  constructor(
    private readonly repos: Repos,
    private readonly settings: SettingsService,
    private readonly profile: ProfileService,
  ) {}

  /** Upsert items coming from the server (or an import). Dedupe by (source, external_id) then URL/title. */
  async ingest(items: NewsItemInput[], ctx: WriteContext = { actor: 'system' }): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0; let updated = 0; let skipped = 0;
    for (const raw of items) {
      const parsed = NewsItemInput.parse(raw);
      const existing = parsed.source_id && parsed.external_id
        ? await this.repos.newsItems.findOne({ source_id: parsed.source_id, external_id: parsed.external_id }, { includeDeleted: true })
        : parsed.url ? await this.repos.newsItems.findOne({ url: parsed.url }, { includeDeleted: true }) : undefined;

      const record = {
        title: parsed.title,
        summary: parsed.summary ?? null,
        what_happened: parsed.what_happened ?? null,
        why_it_matters: parsed.why_it_matters ?? null,
        context: parsed.context ?? null,
        impact: parsed.impact ?? null,
        category: parsed.category,
        urgency: parsed.urgency,
        published_at: parsed.published_at ?? null,
        day_key: parsed.published_at ? dayKey(parsed.published_at) : dayKey(),
        structured: parsed.structured ? 1 : 0,
        url: parsed.url ?? null,
        source_id: parsed.source_id ?? null,
        external_id: parsed.external_id ?? null,
      };

      if (existing) {
        const changed = existing.title !== record.title || existing.urgency !== record.urgency || Number(existing.structured) !== record.structured;
        if (!changed) { skipped += 1; continue; }
        await this.repos.newsItems.update(existing.id, { ...record, relevance: Math.max(Number(existing.relevance ?? 0), parsed.relevance) } as never, ctx);
        updated += 1;
      } else {
        await this.repos.newsItems.insert({ id: newId('news'), ...record, relevance: parsed.relevance, fetched_at: nowIso(), read_at: null, saved_at: null } as never, ctx);
        created += 1;
      }
    }
    return { created, updated, skipped };
  }

  async list(filter: { category?: NewsCategory | NewsCategory[]; urgency?: NewsUrgency; unreadOnly?: boolean; savedOnly?: boolean; limit?: number; since?: string } = {}): Promise<NewsItem[]> {
    const where: Record<string, unknown> = {};
    if (filter.category) where.category = filter.category;
    if (filter.urgency) where.urgency = filter.urgency;
    if (filter.unreadOnly) where.read_at = null;
    if (filter.savedOnly) where.saved_at = { op: 'not_null' };
    if (filter.since) where.published_at = { op: 'gte', value: filter.since };
    const settings = await this.settings.get('news');
    const rows = await this.repos.newsItems.find(where as never, { orderBy: { published_at: 'desc' }, limit: filter.limit ?? 60 });
    if (!settings.enabled) return [];
    const allowed = settings.categories;
    return allowed.length ? rows.filter((r) => allowed.includes(r.category) || r.urgency === 'urgent') : rows;
  }

  async urgent(limit = 5): Promise<NewsItem[]> {
    return this.repos.newsItems.find({ urgency: 'urgent' }, { orderBy: { published_at: 'desc' }, limit });
  }

  async get(id: string): Promise<NewsItem | null> { return (await this.repos.newsItems.byId(id)) ?? null; }

  async markRead(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.newsItems.update(id, { read_at: nowIso() } as never, { ...ctx, audit: false });
  }

  async markSaved(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    const item = await this.repos.newsItems.byId(id);
    await this.repos.newsItems.update(id, { saved_at: item?.saved_at ? null : nowIso() } as never, { ...ctx, reason: 'news bookmark toggled' });
  }

  /** Re-rank against the user's interests/goals — local, cheap, no network. */
  async rankForUser(items: NewsItem[], limit = 20): Promise<NewsItem[]> {
    const interests = (await this.profile.getField('INTERESTS', 'areas'))?.value;
    const keywords = new Set<string>(
      [
        ...(Array.isArray(interests) ? interests.map((i) => String(i).toLowerCase()) : []),
        ...(await this.repos.goals.find({ status: 'active' }, { limit: 20 })).flatMap((g) => (g.title ?? '').toLowerCase().split(/\W+/)),
        ...(await this.repos.skills.find({}, { limit: 30 })).flatMap((s) => (s.name ?? '').toLowerCase().split(/\W+/)),
      ].filter((k) => k.length > 2),
    );
    const scored = items.map((item) => {
      const text = `${item.title} ${item.summary ?? ''} ${item.why_it_matters ?? ''}`.toLowerCase();
      const matches = [...keywords].filter((k) => text.includes(k)).length;
      const recency = item.published_at ? Math.max(0, 1 - Math.abs(daysUntil(item.published_at)) / 14) : 0.3;
      const urgencyBoost = item.urgency === 'urgent' ? 0.25 : 0;
      return { item, score: Math.min(1, Number(item.relevance ?? 0) * 0.4 + Math.min(0.4, matches * 0.12) + recency * 0.2 + urgencyBoost) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.item);
  }

  async digest(day: string = dayKey(), limit = 8): Promise<DailyDigest> {
    const since = `${day}T00:00:00`;
    const candidates = await this.repos.newsItems.find({ published_at: { op: 'gte', value: addMinutes(new Date(since), -12 * 60).toISOString().slice(0, 10) } }, { orderBy: { published_at: 'desc' }, limit: 200 });
    const todays = candidates.filter((c) => (c.day_key ?? dayKey(c.published_at ?? nowIso())) === day);
    const ranked = await this.rankForUser(todays.length ? todays : candidates, limit);
    const items: DigestItem[] = [];
    for (const item of ranked) {
      const source = item.source_id ? await this.repos.newsSources.byId(item.source_id) : null;
      items.push({
        id: item.id, title: item.title, url: item.url, category: item.category, urgency: item.urgency,
        published_at: item.published_at, what_happened: item.what_happened ?? item.summary,
        why_it_matters: item.why_it_matters, context: item.context, impact: item.impact,
        source_name: source?.name ?? null, relevance: Number(item.relevance ?? 0),
      });
    }
    return { day, items, text: renderDigest(day, items), generated_at: nowIso() };
  }

  async sources(): Promise<NewsSource[]> { return this.repos.newsSources.find({}, { orderBy: { category: 'asc', name: 'asc' }, limit: 200 }); }

  async addSource(input: { name: string; url: string; category?: NewsCategory; kind?: 'rss' | 'atom' | 'api'; language?: string }, ctx: WriteContext = USER_WRITE): Promise<NewsSource> {
    const existing = await this.repos.newsSources.findOne({ url: input.url });
    if (existing) return existing;
    return this.repos.newsSources.insert({
      id: newId(), name: input.name, url: input.url, kind: input.kind ?? 'rss', category: input.category ?? 'world',
      language: input.language ?? 'en', enabled: 1, last_fetched_at: null, etag: null,
    } as never, ctx);
  }

  async setSourceEnabled(id: string, enabled: boolean, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.newsSources.update(id, { enabled: enabled ? 1 : 0 } as never, ctx);
  }

  async prune(days = 30): Promise<number> {
    const cutoff = addMinutes(new Date(), -days * 24 * 60).toISOString();
    const res = await this.repos.db.run('DELETE FROM news_items WHERE published_at < ? AND saved_at IS NULL', [cutoff]);
    return res.changes;
  }

  async contextText(limit = 4): Promise<string> {
    const items = await this.rankForUser(await this.list({ limit: 30 }), limit);
    if (!items.length) return '';
    return items.map((i) => `- [${i.category}${i.urgency === 'urgent' ? ', urgent' : ''}] ${i.title}${i.why_it_matters ? ` — ${i.why_it_matters.slice(0, 140)}` : ''}`).join('\n');
  }
}

/** Structured digest rendering: what / why / context / impact / source (req. 48). */
export function renderDigest(day: string, items: DigestItem[]): string {
  if (!items.length) return `No news stored for ${day}. Connect to sync the latest digest.`;
  const lines = [`Digest for ${day} (${items.length} items)`];
  for (const item of items) {
    lines.push(`• ${item.title} [${item.category}]${item.published_at ? ` (${relativeDayLabel(item.published_at)})` : ''}`);
    if (item.what_happened) lines.push(`  What happened: ${item.what_happened}`);
    if (item.why_it_matters) lines.push(`  Why it matters: ${item.why_it_matters}`);
    if (item.context) lines.push(`  Context: ${item.context}`);
    if (item.impact) lines.push(`  Potential impact: ${item.impact}`);
    if (item.source_name || item.url) lines.push(`  Source: ${item.source_name ?? ''}${item.url ? ` ${item.url}` : ''}`);
  }
  return lines.join('\n');
}
