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
`;
