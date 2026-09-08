import type { Database } from '../db/database';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import type { Actor } from '../domain/types';
import { createLogger, type Logger } from '../util/logging';

export interface ServiceContext {
  db: Database;
  repos: Repos;
  deviceId: string;
  logger: Logger;
}

export function createServiceContext(db: Database, repos: Repos, deviceId: string): ServiceContext {
  return { db, repos, deviceId, logger: createLogger('app') };
}

/** Convenience: a write context tagged with the acting device. */
export function writeCtx(actor: Actor, deviceId: string, extra: Partial<WriteContext> = {}): WriteContext {
  return { actor, deviceId, ...extra };
}
