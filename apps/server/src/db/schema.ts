/**
 * Server-side schema.
 *
 * The server deliberately stores **only** what must be shared or secret (docs/08 §1):
 * accounts, sessions, devices, the per-user sync change feed, AI usage and the audit log.
 * Goals, tasks, memories, plans and everything else live in the user's local SQLite —
 * on the server they exist only as opaque, versioned payloads inside the sync feed.
 *
 * That is also why there is no SQL for "the user's data" here: the server cannot run
 * queries over content it never interprets.
 */

export const SERVER_SCHEMA_VERSION = 1;

export const SERVER_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name  TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_used_at  TEXT,
  rotated_from  TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_device ON refresh_tokens(user_id, device_id);

CREATE TABLE IF NOT EXISTS devices (
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  name          TEXT,
  platform      TEXT,
  registered_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- The current authoritative state of every synced entity, per user.
CREATE TABLE IF NOT EXISTS sync_entities (
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  origin_device TEXT,
  updated_at    TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- Append-only change feed: the cursor a client stores is a seq value in this table.
CREATE TABLE IF NOT EXISTS sync_feed (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  base_version  INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  origin_device TEXT,
  updated_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_user_seq ON sync_feed(user_id, seq);

CREATE TABLE IF NOT EXISTS ai_usage (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id        TEXT,
  endpoint         TEXT NOT NULL,
  provider         TEXT,
  model            TEXT,
  tier             TEXT,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  tool_names       TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  event       TEXT NOT NULL,
  device_id   TEXT,
  ip          TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event, created_at);

-- News engine (server side): fetched RSS feeds are parsed, de-duplicated and stored
-- here so every client can pull a structured, offline-capable feed (docs/08 §4).
-- This is public information, not user data — but it is still versioned like the rest.
CREATE TABLE IF NOT EXISTS news_sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'rss',
  enabled         INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,
  last_fetched_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_cache (
  url_hash        TEXT PRIMARY KEY,
  source_id       TEXT REFERENCES news_sources(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  summary         TEXT,
  what_happened   TEXT,
  why_it_matters  TEXT,
  context         TEXT,
  impact          TEXT,
  category        TEXT NOT NULL,
  urgency         TEXT NOT NULL DEFAULT 'digest',
  published_at    TEXT,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_cache_pub ON news_cache(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_cache_cat ON news_cache(category, published_at DESC);

-- Push notifications (docs/08 §5). Subscriptions hold the Web Push endpoint (+ future
-- FCM tokens) and the per-user delivery queue: everything the server creates is stored
-- here first, so a notification that cannot be pushed (app closed, device offline) is
-- still picked up by polling GET /v1/notifications/pending on the next foreground.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'web',   -- web | fcm
  endpoint     TEXT NOT NULL,                 -- Web Push endpoint / FCM registration token
  p256dh       TEXT,
  auth_secret  TEXT,
  user_agent   TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                 -- daily_plan | schedule_start | task_reminder | …
  title        TEXT NOT NULL,
  body         TEXT,
  url          TEXT,
  data         TEXT,                          -- JSON payload for the service worker
  urgent       INTEGER NOT NULL DEFAULT 0,
  dedup_key    TEXT,
  push_sent_at TEXT,
  push_error   TEXT,
  delivered_at TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(user_id, delivered_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(user_id, dedup_key, created_at DESC);
`;
