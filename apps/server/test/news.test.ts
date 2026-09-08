import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/app';
import { loadConfig } from '../src/config';
import type { ServerConfig } from '../src/config';

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
