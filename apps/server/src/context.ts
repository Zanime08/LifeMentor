import type { AIProvider } from '@lifementor/core';
import { hasCloudAI, type ServerConfig } from './config';
import { ServerDb } from './db';
import { AuditLog } from './services/audit';
import { AiGateway } from './services/ai-gateway';
import { SyncStore } from './services/sync-store';
import { TokenService, type JwtSigner } from './services/tokens';
import { UserStore } from './services/users';
import { NewsFeedService, createNewsEnricher } from './services/news-feed';
import { FcmClient } from './services/fcm';
import { PushService } from './services/push';
import { CloudBackupStore } from './services/cloud-backup';

export const SERVER_NAME = 'lifementor-server';
export const SERVER_VERSION = '0.1.1';

/**
 * Everything the HTTP layer needs, wired once at startup.
 *
 * Routes never touch SQL or the environment directly — they call these services, which is what
 * keeps "the server holds the keys, the client holds the data" structurally true.
 */
export interface ServerContext {
  config: ServerConfig;
  db: ServerDb;
  audit: AuditLog;
  users: UserStore;
  tokens: TokenService;
  sync: SyncStore;
  ai: AiGateway;
  news: NewsFeedService;
  push: PushService;
  cloudBackup: CloudBackupStore;
  version: string;
  close(): Promise<void>;
}

export interface ContextOverrides {
  db?: ServerDb;
  jwt?: JwtSigner;
  aiProvider?: AIProvider;
}

export async function createContext(config: ServerConfig, overrides: ContextOverrides = {}): Promise<ServerContext> {
  const db = overrides.db ?? await ServerDb.open({
    path: config.databasePath,
    inMemory: config.databaseInMemory,
    durability: config.env === 'test' ? 'safe' : 'paranoid',
  });

  const audit = new AuditLog(db);
  const users = new UserStore(db);
  const sync = new SyncStore(db, audit);

  if (!overrides.jwt) throw new Error('createContext requires a JWT signer (registered by the HTTP layer)');
  const tokens = new TokenService(db, overrides.jwt, {
    accessTtlSeconds: config.accessTokenTtlSeconds,
    refreshTtlDays: config.refreshTokenTtlDays,
  });

  const ai = new AiGateway(db, audit, config, overrides.aiProvider);

  // News polling runs only in real (non-test) servers; tests stay hermetic.
  // LLM enrichment activates only when a real cloud provider is configured — the local
  // heuristic is the deterministic fallback, not an LLM, so it must not be labeled as one.
  const newsEnricher = hasCloudAI(config) ? createNewsEnricher(ai.provider) : null;
  const news = new NewsFeedService(
    db,
    config.env === 'test' ? Number.MAX_SAFE_INTEGER : 30 * 60_000,
    newsEnricher,
  );
  if (config.env !== 'test') void news.start();

  // FCM transport (Android, docs/11 §8): enabled only when a Firebase service account is
  // configured; otherwise the polling fallback still delivers `fcm` subscriptions.
  const fcm = new FcmClient(config.push.fcm);
  const push = new PushService(db, config.push, fcm);
  const cloudBackup = new CloudBackupStore(db);

  // Server-initiated push (docs/08 §5): when the poller finds new urgent items, notify every
  // subscribed user within the daily cap.
  news.onNewUrgent = (items) => push
    .usersWithSubscriptions()
    .then(async (userIds) => {
      let total = 0;
      for (const userId of userIds) total += await push.notifyUrgentNews(userId, items);
      return total;
    })
    .catch(() => undefined);

  return {
    config, db, audit, users, tokens, sync, ai, news, push, cloudBackup, version: SERVER_VERSION,
    async close(): Promise<void> {
      news.stop();
      await db.close();
    },
  };
}
