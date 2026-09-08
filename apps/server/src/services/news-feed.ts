import type { ServerDb } from '../db';
import { createLogger } from '@lifementor/core';

const log = createLogger('news');

/**
 * Server-side news engine (req. 47–48).
 *
 * Polls real RSS/Atom feeds on an interval, parses them with a compact
 * dependency-free parser, de-duplicates by link hash, scores urgency with a
 * transparent keyword heuristic and structures every item into
 * what happened / why it matters / context / source. The cache is served to
 * authenticated clients through GET /v1/news — the client ingests the items
 * into its local SQLite, so the feed and the daily digest stay readable
 * offline. No fake items are ever generated: if a feed cannot be fetched,
 * its absence is reported honestly.
 */

export interface NewsFeedItem {
  id: string;
  source_id: string | null;
  external_id: string | null;
  url: string;
  title: string;
  summary: string | null;
  what_happened: string | null;
  why_it_matters: string | null;
  context: string | null;
  impact: string | null;
  category: string;
  urgency: 'urgent' | 'digest';
  relevance: number;
  published_at: string | null;
  fetched_at: string;
}

interface FeedSource {
  id: string;
  name: string;
  url: string;
  category: 'world' | 'technology' | 'ai' | 'economy' | 'business' | 'science' | 'geopolitics' | 'programming';
  kind: 'rss' | 'atom';
}

export const DEFAULT_FEEDS: FeedSource[] = [
  { id: 'feed-lenta', name: 'Lenta.ru', url: 'https://lenta.ru/rss', category: 'world', kind: 'rss' },
  { id: 'feed-tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', category: 'geopolitics', kind: 'rss' },
  { id: 'feed-verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'technology', kind: 'atom' },
  { id: 'feed-techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'technology', kind: 'rss' },
  { id: 'feed-ainews', name: 'AI News', url: 'https://www.artificialintelligence-news.com/feed/', category: 'ai', kind: 'rss' },
  { id: 'feed-nytbusiness', name: 'NYT Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'economy', kind: 'rss' },
  { id: 'feed-sa', name: 'Scientific American', url: 'https://feeds.scientificamerican.com/scientificamerican', category: 'science', kind: 'rss' },
  { id: 'feed-habr', name: 'Хабр Новости', url: 'https://habr.com/ru/rss/news/?fl=ru', category: 'programming', kind: 'rss' },
];

const URGENT_KEYWORDS = [
  // english
  'breaking', 'urgent', 'emergency', 'attack', 'attacked', 'strike', 'struck', 'war', 'military operation',
  'election', 'resign', 'resignation', 'impeach', 'record high', 'record low', 'crisis', 'collapse', 'outage',
  'cyberattack', 'earthquake', 'volcano', 'pandemic', 'sanctions', 'no-deal',
  // russian
  'срочно', 'экстренно', 'авария', 'взрыв', 'обрушение', 'теракт', 'атака', 'удар', 'выборы', 'отставка',
  'санкции', 'кризис', 'рекорд', 'землетрясение', 'пожар', 'катастрофа', 'задержание', 'прорыв', 'впервые',
];

const IMPACT_KEYWORDS = ['market', 'economy', 'economic', 'inflation', 'rates', 'stock', 'exchange', 'рубл', 'доллар', 'инфляц', 'рекорд', 'record', 'sanction', 'санкци', 'export', 'экспорт', 'import', 'импорт', 'oil', 'нефт'];

const WHY_RU_EN: Record<string, string> = {
  world: 'Мировые события задают общий фон: политика, конфликты и крупные происшествия влияют на рынки, безопасность и планы.',
  geopolitics: 'Геополитика определяет санкционные и логистические риски, за которыми следуют цены и доступность.',
  technology: 'Технологические сдвиги меняют, какие навыки и инструменты становятся востребованными.',
  ai: 'Развитие ИИ напрямую влияет на рынок труда, инструменты автоматизации и новые профессиональные пути.',
  economy: 'Макроэкономика влияет на стоимость жизни, доходность сбережений и условия для бизнеса.',
  business: 'Бизнес-новости показывают, как компании адаптируются — полезно для карьерных и продуктовых решений.',
  science: 'Научные результаты — источник будущих технологий и долгосрочных возможностей.',
  programming: 'Практические новости из сферы разработки помогают калибровать выбор стека и направлений обучения.',
};

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? stripHtml(m[1]) : null;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function hashUrl(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

interface ParsedItem {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null;
}

/** Compact RSS 2.0 / Atom parser — good enough for the feeds we actually use. */
function parseFeed(xml: string, kind: 'rss' | 'atom'): ParsedItem[] {
  const items: ParsedItem[] = [];
  const chunks = kind === 'atom'
    ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? []
    : xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const chunk of chunks.slice(0, 30)) {
    const title = textOf(chunk, 'title');
    const link = kind === 'atom'
      ? (chunk.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] ?? textOf(chunk, 'link'))
      : textOf(chunk, 'link');
    if (!title || !link) continue;
    const summary = textOf(chunk, 'description') ?? textOf(chunk, 'content:encoded') ?? textOf(chunk, 'summary') ?? textOf(chunk, 'content');
    const published = textOf(chunk, 'pubDate') ?? textOf(chunk, 'published') ?? textOf(chunk, 'updated');
    items.push({ title, url: link.trim(), summary: summary ? summary.slice(0, 700) : null, publishedAt: parseDate(published) });
  }
  return items;
}

function urgencyOf(title: string, summary: string | null): 'urgent' | 'digest' {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  const hits = URGENT_KEYWORDS.filter((k) => text.includes(k));
  return hits.length >= 1 ? 'urgent' : 'digest';
}

function impactOf(title: string, summary: string | null): string | null {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  if (!IMPACT_KEYWORDS.some((k) => text.includes(k))) return null;
  return 'Возможное влияние: на стоимость жизни, цены на ввозимые товары и доходность сбережений стоит перепроверить свои планы на ближайшие недели.';
}

export class NewsFeedService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * Hook for server-initiated push (docs/08 §5): called after a refresh that added urgent
   * items, so the push layer can notify subscribed users within budget. Must never throw
   * (a push failure must not break the news flow) — the caller still handles errors.
   */
  onNewUrgent: ((items: { url: string; title: string }[]) => Promise<unknown> | unknown) | null = null;

  constructor(private readonly db: ServerDb, private readonly intervalMs = 30 * 60_000) {}

  async start(): Promise<void> {
    await this.ensureDefaultSources();
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh().catch((error) => {
        log.warn('scheduled news refresh failed', { error: error instanceof Error ? error.message : String(error) });
      }), this.intervalMs);
      this.timer.unref?.();
    }
    // First fetch on startup (non-blocking); failures are logged and reported, never faked.
    void this.refresh().catch((error) => log.warn('initial news refresh failed', { error: error instanceof Error ? error.message : String(error) }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Idempotently seed the built-in feed list. */
  async ensureDefaultSources(): Promise<void> {
    for (const feed of DEFAULT_FEEDS) {
      await this.db.run(
        'INSERT INTO news_sources (id, name, url, category, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?) ' +
        'ON CONFLICT(url) DO NOTHING',
        [feed.id, feed.name, feed.url, feed.category, feed.kind, new Date().toISOString()],
      ).catch(() => undefined);
    }
  }

  /** Fetch all enabled sources; returns per-source stats (honest about failures). */
  async refresh(): Promise<{ ok: number; failed: number; added: number; error?: string }> {
    if (this.running) return { ok: 0, failed: 0, added: 0, error: 'refresh already in progress' };
    this.running = true;
    try {
      await this.ensureDefaultSources();
      const sources = await this.db.all<{ id: string; url: string; category: string; kind: string; name: string }>(
        'SELECT id, url, category, kind, name FROM news_sources WHERE enabled = 1',
      );
      let ok = 0;
      let failed = 0;
      let added = 0;
      let lastError: string | undefined;
      const urgentAdded: { url: string; title: string }[] = [];
      for (const source of sources) {
        try {
          const { added: n, urgent } = await this.fetchOne(source);
          ok += 1;
          added += n;
          urgentAdded.push(...urgent);
        } catch (error) {
          failed += 1;
          lastError = `${source.name}: ${error instanceof Error ? error.message : String(error)}`;
          await this.db.run('UPDATE news_sources SET last_error = ? WHERE id = ?', [lastError, source.id]).catch(() => undefined);
        }
      }
      await this.prune(60);
      // Server-initiated push for urgent items (docs/08 §5). Push problems are logged, never
      // allowed to fail the news refresh itself.
      if (urgentAdded.length && this.onNewUrgent) {
        try {
          await this.onNewUrgent(urgentAdded);
        } catch (error) {
          log.warn('urgent-news push hook failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { ok, failed, added, error: failed ? lastError : undefined };
    } finally {
      this.running = false;
    }
  }

  private async fetchOne(source: { id: string; url: string; category: string; kind: string; name: string }): Promise<{ added: number; urgent: { url: string; title: string }[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(source.url, {
        signal: controller.signal,
        headers: { 'user-agent': 'LifeMentor-News/0.1 (+personal feed aggregator)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const parsed = parseFeed(xml, source.kind === 'atom' ? 'atom' : 'rss');
    if (!parsed.length) throw new Error('no items parsed');

    let added = 0;
    const urgent: { url: string; title: string }[] = [];
    for (const item of parsed) {
      const urlHash = hashUrl(item.url);
      const exists = await this.db.get('SELECT url_hash FROM news_cache WHERE url_hash = ?', [urlHash]);
      if (exists) continue;
      const urgency = urgencyOf(item.title, item.summary);
      const why = WHY_RU_EN[source.category] ?? WHY_RU_EN.world;
      const context = `${source.name}, ${item.publishedAt ? new Date(item.publishedAt).toUTCString() : 'дата не указана'}`;
      await this.db.run(
        `INSERT INTO news_cache (url_hash, source_id, title, url, summary, what_happened, why_it_matters, context, impact, category, urgency, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url_hash) DO NOTHING`,
        [
          urlHash, source.id, item.title, item.url, item.summary,
          item.summary ?? item.title, why, context, impactOf(item.title, item.summary),
          source.category, urgency, item.publishedAt, new Date().toISOString(),
        ],
      );
      added += 1;
      if (urgency === 'urgent') urgent.push({ url: item.url, title: item.title });
    }
    const etag = response.headers.get('etag') ?? null;
    await this.db.run('UPDATE news_sources SET last_fetched_at = ?, etag = ?, last_error = NULL WHERE id = ?', [
      new Date().toISOString(), etag, source.id,
    ]);
    return { added, urgent };
  }

  private async prune(days: number): Promise<void> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await this.db.run('DELETE FROM news_cache WHERE fetched_at < ?', [cutoff]);
  }

  /** Served to authenticated clients (GET /v1/news). */
  async items(limit: number): Promise<{ items: NewsFeedItem[]; last_fetched_at: string | null; error: string | null }> {
    const rows = await this.db.all<{
      url_hash: string; source_id: string | null; title: string; url: string; summary: string | null;
      what_happened: string | null; why_it_matters: string | null; context: string | null; impact: string | null;
      category: string; urgency: string; published_at: string | null; fetched_at: string;
    }>(
      `SELECT * FROM news_cache
       ORDER BY CASE WHEN urgency = 'urgent' THEN 0 ELSE 1 END,
                CASE WHEN published_at IS NULL THEN 1 ELSE 0 END,
                published_at DESC
       LIMIT ?`,
      [Math.max(1, Math.min(200, limit))],
    );
    const last = await this.db.get<{ last_fetched_at: string | null }>('SELECT MAX(last_fetched_at) AS last_fetched_at FROM news_sources');
    const errorRow = await this.db.get<{ last_error: string | null }>('SELECT last_error FROM news_sources WHERE last_error IS NOT NULL ORDER BY last_fetched_at DESC LIMIT 1');
    return {
      items: rows.map((r) => ({
        id: r.url_hash,
        source_id: r.source_id,
        external_id: r.url_hash,
        url: r.url,
        title: r.title,
        summary: r.summary,
        what_happened: r.what_happened,
        why_it_matters: r.why_it_matters,
        context: r.context,
        impact: r.impact,
        category: r.category as NewsFeedItem['category'],
        urgency: r.urgency as NewsFeedItem['urgency'],
        relevance: r.urgency === 'urgent' ? 0.9 : 0.5,
        published_at: r.published_at,
        fetched_at: r.fetched_at,
      })),
      last_fetched_at: last?.last_fetched_at ?? null,
      error: errorRow?.last_error ?? null,
    };
  }

  async sourceStats(): Promise<{ total: number; by_category: Record<string, number>; feeds_ok: number; feeds_failed: number }> {
    const total = Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_cache'))?.n ?? 0);
    const cats = await this.db.all<{ category: string; n: number }>('SELECT category, COUNT(*) AS n FROM news_cache GROUP BY category');
    const feeds = await this.db.get<{ ok: number; failed: number }>('SELECT COUNT(CASE WHEN last_error IS NULL THEN 1 END) AS ok, COUNT(CASE WHEN last_error IS NOT NULL THEN 1 END) AS failed FROM news_sources');
    return { total, by_category: Object.fromEntries(cats.map((c) => [c.category, c.n])), feeds_ok: Number(feeds?.ok ?? 0), feeds_failed: Number(feeds?.failed ?? 0) };
  }
}
