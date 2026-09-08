import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { ServerConfig } from '../src/config';
import { ServerDb } from '../src/db';
import { NewsFeedService, createNewsEnricher } from '../src/services/news-feed';
import type { NewsEnricher } from '../src/services/news-feed';

function testConfig(): ServerConfig {
  const config = loadConfig();
  return { ...config, env: 'test', databaseInMemory: true, jwtSecret: 'test-secret-0123456789' } as ServerConfig;
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title>Central bank raises rates to record high</title><link>https://example.com/1</link><pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Policymakers lifted the key rate.&lt;/p&gt;</description></item>
<item><title>New programming framework released</title><link>https://example.com/2</link><pubDate>Mon, 07 Sep 2026 09:00:00 GMT</pubDate><description>A new toolchain for web apps.</description></item>
</channel></rss>`;

describe('news engine (server)', () => {
  it('serves an honest empty feed before any fetch and reports failures, never fakes items', async () => {
    const originalFetch = globalThis.fetch;
    // no network available: every feed fetch fails — the engine must report it, not invent items
    globalThis.fetch = (async () => { throw new TypeError('fetch failed (no network in test)'); }) as typeof fetch;

    const { app, shutdown } = await buildServer(testConfig());
    try {
      // unauthenticated — rejected
      const unauthorized = await app.inject({ method: 'GET', url: '/v1/news' });
      expect(unauthorized.statusCode).toBe(401);

      // register a user to get a token
      const registered = await app.inject({
        method: 'POST', url: '/v1/auth/register',
        payload: { email: 'news@test.dev', password: 'supersecret1', device_id: 'device-news' },
      });
      expect(registered.statusCode).toBe(201);
      const token = (registered.json() as { access_token: string }).access_token;

      const before = await app.inject({ method: 'GET', url: '/v1/news?limit=10', headers: { authorization: `Bearer ${token}` } });
      expect(before.statusCode).toBe(200);
      const body = before.json() as { items: unknown[] };
      expect(body.items).toEqual([]);

      // manual refresh with no network: must report failure honestly, not invent items
      const refreshed = await app.inject({ method: 'POST', url: '/v1/news/refresh', headers: { authorization: `Bearer ${token}` } });
      expect(refreshed.statusCode).toBe(200);
      const refreshBody = refreshed.json() as { ok: number; failed: number; added: number };
      expect(refreshBody.ok).toBe(0);
      expect(refreshBody.failed).toBeGreaterThan(0);
      expect(refreshBody.added).toBe(0);

      const after = await app.inject({ method: 'GET', url: '/v1/news', headers: { authorization: `Bearer ${token}` } });
      expect((after.json() as { items: unknown[] }).items).toEqual([]);

      await shutdown();
    } finally {
      globalThis.fetch = originalFetch;
      await shutdown().catch(() => undefined);
    }
  });

  it('enriches new items with the LLM within the per-refresh cap, falls back on failure', async () => {
    const db = await ServerDb.open({ inMemory: true });
    try {
      let calls = 0;
      const enricher: NewsEnricher = async (input) => {
        calls += 1;
        // The second item's enrichment fails — that item must get the deterministic text.
        if (input.title.includes('framework')) throw new Error('AI unavailable');
        return {
          what_happened: `AI: ${input.title.slice(0, 40)}`,
          why_it_matters: 'AI: важно для планирования',
          context: `AI: ${input.sourceName}`,
        };
      };
      const svc = new NewsFeedService(db, Number.MAX_SAFE_INTEGER, enricher);
      await svc.ensureDefaultSources();
      await db.run('UPDATE news_sources SET enabled = 0');
      await db.run(
        "INSERT INTO news_sources (id, name, url, category, kind, enabled, created_at) VALUES ('feed-test', 'Test Feed', 'https://example.com/feed.xml', 'economy', 'rss', 1, ?)",
        [new Date().toISOString()],
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('example.com')) {
          return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
        }
        return originalFetch(input as RequestInfo);
      }) as typeof fetch;
      try {
        const result = await svc.refresh();
        expect(result.added).toBe(2);

        // Both items went through the enricher (within the cap of 6).
        expect(calls).toBe(2);

        const items = await svc.items(50);
        const urgent = items.items.find((i) => i.urgency === 'urgent');
        const failed = items.items.find((i) => i.title.includes('framework'));
        // The successful item carries the AI text.
        expect(urgent?.what_happened).toContain('AI:');
        expect(urgent?.why_it_matters).toContain('AI:');
        expect(urgent?.context).toContain('AI: Test Feed');
        // The failed item fell back to deterministic text (summary as what, category template as why).
        expect(failed?.what_happened).not.toContain('AI:');
        expect(failed?.why_it_matters).toContain('Макроэкономика');
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await db.close();
    }
  });

  it('respects the per-refresh enrichment cap (cost control, §97)', async () => {
    const db = await ServerDb.open({ inMemory: true });
    try {
      const enricher: NewsEnricher = async () => ({
        what_happened: 'AI: x', why_it_matters: 'AI: y', context: 'AI: z',
      });
      const svc = new NewsFeedService(db, Number.MAX_SAFE_INTEGER, enricher);
      await svc.ensureDefaultSources();
      await db.run('UPDATE news_sources SET enabled = 0');
      // A feed with 10 distinct items — more than the cap of 6.
      const items = Array.from({ length: 10 }, (_, i) =>
        `<item><title>Ordinary item number ${i + 1}</title><link>https://example.com/${i + 1}</link>` +
        `<pubDate>Mon, 07 Sep 2026 10:00:00 GMT</pubDate><description>text ${i + 1}</description></item>`).join('');
      const many = `<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title>${items}</channel></rss>`;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('example.com')) return new Response(many, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
        return originalFetch(input as RequestInfo);
      }) as typeof fetch;
      try {
        await db.run(
          "INSERT INTO news_sources (id, name, url, category, kind, enabled, created_at) VALUES ('feed-test', 'Test Feed', 'https://example.com/feed.xml', 'world', 'rss', 1, ?)",
          [new Date().toISOString()],
        );
        const result = await svc.refresh();
        expect(result.added).toBe(10);

        // Only the first 6 got AI text; the rest kept the deterministic fallback.
        const all = await svc.items(50);
        const aiEnriched = all.items.filter((i) => i.what_happened === 'AI: x');
        expect(aiEnriched).toHaveLength(6);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await db.close();
    }
  });

  it('createNewsEnricher: structured output, cheap tier, null on provider failure', async () => {
    const requests: unknown[] = [];
    const mockProvider = {
      id: 'mock',
      capabilities: { generation: true, streaming: false, tools: false, embeddings: false },
      isAvailable: () => true,
      stream: async () => { throw new Error('not used'); },
      embed: async () => [[]],
      generate: async () => { throw new Error('not used'); },
      generateStructured: async (request: unknown) => {
        requests.push(request);
        return { what_happened: '  Что случилось  ', why_it_matters: '  Почему важно  ', context: '  Источник, 7 сен 2026  ' };
      },
    };
    const enricher = createNewsEnricher(mockProvider as never);
    const result = await enricher({
      title: 'Банк поднял ставку', summary: 'Ключевая ставка выросла.', category: 'economy',
      sourceName: 'Test Feed', publishedAt: '2026-09-07T10:00:00.000Z', urgent: false,
    });
    expect(result).toEqual({ what_happened: 'Что случилось', why_it_matters: 'Почему важно', context: 'Источник, 7 сен 2026' });
    const req = requests[0] as { tier: string; maxTokens: number; messages: { role: string; content: string }[] };
    expect(req.tier).toBe('cheap');
    expect(req.maxTokens).toBe(300);
    expect(req.messages[0].content).toContain('Банк поднял ставку');
    expect(req.messages[0].content).toContain('Test Feed');

    // Provider failure → null (the caller keeps the deterministic text), never throws.
    const failing = createNewsEnricher({
      ...mockProvider,
      generateStructured: async () => { throw new Error('provider down'); },
    } as never);
    await expect(failing({ title: 't', summary: null, category: 'world', sourceName: 's', publishedAt: null, urgent: false }))
      .resolves.toBeNull();
  });

  it('parses RSS and structures items with urgency scoring when fetch succeeds', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes('example.com')) {
        return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      }
      return originalFetch(input as RequestInfo);
    }) as typeof fetch;

    try {
      const { app, shutdown, context } = await buildServer(testConfig());
      try {
        // seed the default feeds, disable them all, then enable only the controllable test feed
        await context.news.ensureDefaultSources();
        await context.db.run('UPDATE news_sources SET enabled = 0');
        await context.db.run(
          "INSERT INTO news_sources (id, name, url, category, kind, enabled, created_at) VALUES ('feed-test', 'Test Feed', 'https://example.com/feed.xml', 'economy', 'rss', 1, ?)",
          [new Date().toISOString()],
        );

        const result = await context.news.refresh();
        expect(fetchCalls).toBeGreaterThan(0);
        expect(result.ok).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.added).toBe(2);

        const items = await context.news.items(50);
        expect(items.items).toHaveLength(2);
        const urgent = items.items.find((i) => i.urgency === 'urgent');
        const normal = items.items.find((i) => i.urgency === 'digest');
        expect(urgent).toBeDefined();
        expect(urgent!.title).toContain('record high');
        expect(urgent!.what_happened).toContain('key rate');
        expect(urgent!.why_it_matters).toBeTruthy();
        expect(urgent!.context).toContain('Test Feed');
        expect(normal!.title).toContain('framework');

        // idempotent: re-fetch adds nothing
        const second = await context.news.refresh();
        expect(second.added).toBe(0);

        await shutdown();
      } finally {
        await shutdown().catch(() => undefined);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
