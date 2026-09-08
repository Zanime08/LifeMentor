import type { AIProvider } from '@lifementor/core';
import type { ServerConfig } from './config';
import { ServerDb } from './db';
import { AuditLog } from './services/audit';
import { AiGateway } from './services/ai-gateway';
import { SyncStore } from './services/sync-store';
import { TokenService, type JwtSigner } from './services/tokens';
import { UserStore } from './services/users';

export const SERVER_NAME = 'lifementor-server';
export const SERVER_VERSION = '0.1.0';

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

  return {
    config, db, audit, users, tokens, sync, ai, version: SERVER_VERSION,
    async close(): Promise<void> {
      await db.close();
    },
  };
}
