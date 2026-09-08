import { loadConfig } from '../config';
import { ServerDb } from '../db';

/**
 * `npm run db:integrity --workspace @lifementor/server`
 *
 * Operator diagnostic: opens the server database read-only-ish, runs SQLite's integrity and
 * foreign-key checks, and reports row counts per table plus the size of the sync feed.
 * Exits non-zero when something is wrong so it can be used in a health cron.
 */

const COUNTED_TABLES = ['users', 'refresh_tokens', 'devices', 'sync_entities', 'sync_feed', 'ai_usage', 'audit_log'];

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await ServerDb.open({ path: config.databasePath, inMemory: false, durability: 'safe' });

  const integrity = await db.integrityCheck();
  const version = await db.schemaVersion();
  const journal = await db.get<{ journal_mode: string | null }>('PRAGMA journal_mode');

  process.stdout.write(`\nLifeMentor server database — ${db.describe()}\n`);
  process.stdout.write(`  schema version : ${version}\n`);
  process.stdout.write(`  journal mode   : ${journal?.journal_mode ?? 'unknown'}\n`);
  process.stdout.write(`  integrity      : ${integrity.ok ? 'ok' : `FAILED (${integrity.detail})`}\n\n`);

  for (const table of COUNTED_TABLES) {
    const row = await db.get<{ n: number | null }>(`SELECT COUNT(*) AS n FROM ${table}`).catch(() => undefined);
    process.stdout.write(`  ${table.padEnd(16)} ${row?.n ?? 'n/a'}\n`);
  }

  const feed = await db.get<{ users: number | null; oldest: string | null; newest: string | null }>(
    'SELECT COUNT(DISTINCT user_id) AS users, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM sync_feed',
  );
  process.stdout.write(`\n  sync feed      : ${feed?.users ?? 0} user(s), ${feed?.oldest ?? '—'} → ${feed?.newest ?? '—'}\n`);

  const usage = await db.get<{ day: string | null; tokens: number | null }>(
    `SELECT substr(created_at, 1, 10) AS day, SUM(prompt_tokens + completion_tokens) AS tokens
     FROM ai_usage GROUP BY day ORDER BY day DESC LIMIT 1`,
  );
  process.stdout.write(`  ai usage today : ${usage?.tokens ?? 0} tokens (${usage?.day ?? 'no requests'})\n\n`);

  await db.close();
  if (!integrity.ok) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`integrity check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
