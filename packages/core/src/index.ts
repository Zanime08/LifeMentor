/**
 * `@lifementor/core` — the platform-independent heart of LifeMentor.
 *
 * Everything the desktop, mobile, web and server apps use lives here: the domain model, the SQLite
 * persistence layer, the services (goals, tasks, calendar, learning, memory, news, notifications,
 * progress, strategy, planning, onboarding, sync, backup, recovery, auth) and the AI layer
 * (provider abstraction, tool registry, context engine, orchestrator, mentor persona).
 *
 * Deliberately NOT exported here: platform entry points that pull in runtime-specific code.
 * Import those from their own subpath so a browser bundle never sees `node:sqlite`:
 *   - `@lifementor/core/node`       — Node/desktop SQL driver (better durability, VACUUM backups)
 *   - `@lifementor/core/wasm`       — sql.js driver for the browser preview
 *   - `@lifementor/core/tauri`      — Tauri 2 driver bridge
 *   - `@lifementor/core/capacitor`  — Capacitor driver bridge
 */

// ── application root ────────────────────────────────────────────────────
export {
  LifeMentorApp,
  type AppAI,
  type AppServices,
  type AuthOptions,
  type BackupOptions,
  type LifeMentorOptions,
  type SyncOptions,
} from './app';

// ── domain ──────────────────────────────────────────────────────────────
export * from './domain/types';

// ── persistence ─────────────────────────────────────────────────────────
export * from './db/driver';
export * from './db/database';
export * from './db/repo';
export * from './db/repos';
export * from './db/create-driver';
export * from './db/migrations/index';

// ── platform abstraction ────────────────────────────────────────────────
export * from './platform/adapter';
export * from './platform/storage';

// ── services ────────────────────────────────────────────────────────────
export * from './services/settings';
export * from './services/personalization';
export * from './services/profile';
export * from './services/goals';
export * from './services/tasks';
export * from './services/calendar';
export * from './services/projects';
export * from './services/skills';
export * from './services/knowledge';
export * from './services/learning';
export * from './services/memory';
export * from './services/context';
export * from './services/news';
export * from './services/notifications';
export * from './services/progress';
export * from './services/sync';
export * from './services/backup';
export * from './services/recovery';
export * from './services/auth';

// ── strategy, planning, onboarding ──────────────────────────────────────
export * from './strategy/strategy';
export * from './planning/planner';
export * from './onboarding/service';
export * from './onboarding/interview';
export * from './onboarding/questions';

// ── AI layer ────────────────────────────────────────────────────────────
export * from './ai/types';
export * from './ai/providers/index';
export * from './ai/tools';
export * from './ai/context-engine';
export * from './ai/conversation';
export * from './ai/orchestrator';
export * from './ai/mentor';

// ── utilities ───────────────────────────────────────────────────────────
export * from './util/id';
export * from './util/time';
export * from './util/result';
export * from './util/logging';
