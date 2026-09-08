/**
 * Migration 0001 — initial LifeMentor schema (docs/03-database-schema.md).
 *
 * Portable SQLite DDL: runs unchanged on node:sqlite (server/CLI/tests), rusqlite (Windows),
 * the Android platform SQLite (Capacitor) and sql.js WASM (browser dev preview).
 *
 * Conventions:
 *  - TEXT primary keys holding client-generated UUIDv7 (offline-safe, time-ordered)
 *  - UTC ISO-8601 timestamps; local day keys (YYYY-MM-DD) where a human day matters
 *  - every synced entity: created_at, updated_at, version, deleted, sync_state
 *  - JSON payloads are stored as TEXT and validated in TypeScript (never queried blindly)
 */
export const MIGRATION_0001 = `
-- ───────────────────────────────────────── meta / account / settings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',
  server_url    TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  deleted       INTEGER NOT NULL DEFAULT 0,
  sync_state    TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS session (
  user_id           TEXT PRIMARY KEY,
  access_token      TEXT,
  refresh_token     TEXT,
  access_expires_at TEXT,
  device_id         TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,
  is_current    INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  scope      TEXT NOT NULL DEFAULT 'synced',      -- synced | local
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'local'
);

-- UI drafts / last route / half-finished forms: local only, restored after a crash.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ───────────────────────────────────────── onboarding & user model ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress | awaiting_interview | awaiting_confirmation | completed | abandoned
  stage         TEXT NOT NULL DEFAULT 'questionnaire', -- questionnaire | analysis | interview | confirmation | goals | skills | plan | done
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  answers_count INTEGER NOT NULL DEFAULT 0,
  model_json    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  deleted       INTEGER NOT NULL DEFAULT 0,
  sync_state    TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS onboarding_answers (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  block        TEXT NOT NULL,
  question_key TEXT NOT NULL,
  answer_kind  TEXT NOT NULL DEFAULT 'text',            -- text | single | multi | scale | time | date
  answer       TEXT NOT NULL,
  label        TEXT,
  source       TEXT NOT NULL DEFAULT 'user_provided',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (session_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_answers_session ON onboarding_answers(session_id, position);

CREATE TABLE IF NOT EXISTS interview_questions (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  gap_type       TEXT NOT NULL,                         -- missing_data | contradiction | vague_goal | goal_conflict | skill_ambiguity | unknown_constraint | missing_horizon
  target         TEXT,                                  -- which model section/field this improves
  question       TEXT NOT NULL,
  rationale      TEXT,                                  -- why the AI asked (shown to the user, auditability)
  importance     REAL NOT NULL DEFAULT 0.5,
  status         TEXT NOT NULL DEFAULT 'pending',       -- pending | asked | answered | skipped
  answer         TEXT,
  changed_model  INTEGER NOT NULL DEFAULT 0,
  asked_at       TEXT,
  answered_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  deleted        INTEGER NOT NULL DEFAULT 0,
  sync_state     TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_interview_session ON interview_questions(session_id, status);

CREATE TABLE IF NOT EXISTS profile_fields (
  id         TEXT PRIMARY KEY,
  section    TEXT NOT NULL,                             -- PROFILE | VALUES | GOALS | CONSTRAINTS | INTERESTS | SKILLS | KNOWLEDGE | PROJECTS | PREFERENCES | TIME_AVAILABILITY | MOTIVATION_FACTORS | DISTRACTIONS | LEARNING_PREFERENCES | CAREER_DIRECTION | FINANCIAL_DIRECTION
  field_key  TEXT NOT NULL,
  label      TEXT,
  value      TEXT NOT NULL,
  value_kind TEXT NOT NULL DEFAULT 'text',              -- text | number | bool | list | json | scale
  source     TEXT NOT NULL DEFAULT 'user_provided',     -- user_provided | ai_inferred | system_observed | unknown
  confidence TEXT NOT NULL DEFAULT 'confirmed',         -- confirmed | inferred | uncertain
  evidence   TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'local',
  UNIQUE (section, field_key)
);
CREATE INDEX IF NOT EXISTS idx_profile_section ON profile_fields(section, deleted);

CREATE TABLE IF NOT EXISTS user_model_snapshots (
  id         TEXT PRIMARY KEY,
  trigger    TEXT NOT NULL,                             -- onboarding_confirmed | monthly_review | manual | import
  model_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ───────────────────────────────────────── goals & strategy ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  area         TEXT,
  horizon      TEXT NOT NULL DEFAULT 'medium',          -- long | medium | short | daily
  status       TEXT NOT NULL DEFAULT 'active',          -- active | paused | achieved | abandoned | archived
  priority     TEXT NOT NULL DEFAULT 'P2',              -- P0 | P1 | P2 | P3
  parent_id    TEXT REFERENCES goals(id) ON DELETE SET NULL,
  motivation   TEXT,
  metric_json  TEXT,                                    -- { kind, target, current, unit }
  progress     REAL NOT NULL DEFAULT 0,
  start_date   TEXT,
  target_date  TEXT,
  completed_at TEXT,
  archived_at  TEXT,
  strict       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, deleted, horizon);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);
CREATE INDEX IF NOT EXISTS idx_goals_target ON goals(target_date);

CREATE TABLE IF NOT EXISTS goal_relationships (
  id              TEXT PRIMARY KEY,
  parent_goal_id  TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  child_goal_id   TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL DEFAULT 'supports',     -- supports | requires | conflicts_with
  note            TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (parent_goal_id, child_goal_id, relation_type)
);

CREATE TABLE IF NOT EXISTS goal_reviews (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  reviewed_at   TEXT NOT NULL,
  findings_json TEXT,
  recommendation TEXT,
  decision      TEXT,                                   -- keep | adjust | pause | archive | split
  status_before TEXT,
  status_after  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_reviews_goal ON goal_reviews(goal_id, reviewed_at);

CREATE TABLE IF NOT EXISTS strategy_items (
  id          TEXT PRIMARY KEY,
  horizon     TEXT NOT NULL,                            -- 3-5y | 1y | 3mo | 1mo | 1w | today | now
  title       TEXT NOT NULL,
  description TEXT,
  goal_id     TEXT REFERENCES goals(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  position    INTEGER NOT NULL DEFAULT 0,
  review_at   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0,
  sync_state  TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_strategy_horizon ON strategy_items(horizon, status, position);

-- Append-only evolution history (req. 81). Never updated, never deleted by the app.
CREATE TABLE IF NOT EXISTS strategy_changes (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'user',             -- user | ai | system | sync | import
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_changes_entity ON strategy_changes(entity_type, entity_id, created_at);

-- ───────────────────────────────────────── skills & knowledge ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  domain             TEXT,
  description        TEXT,
  level              INTEGER NOT NULL DEFAULT 0,        -- 0..100
  confidence         TEXT NOT NULL DEFAULT 'uncertain', -- confirmed | inferred | uncertain
  self_rating        INTEGER,
  weak_points        TEXT,                              -- JSON array
  evidence_json      TEXT,                              -- JSON array of evidence refs
  goal_id            TEXT REFERENCES goals(id) ON DELETE SET NULL,
  last_assessment_at TEXT,
  next_assessment_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  deleted            INTEGER NOT NULL DEFAULT 0,
  sync_state         TEXT NOT NULL DEFAULT 'local',
  UNIQUE (name, domain)
);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain, deleted);

-- A skill level may only change through an assessment row with evidence (req. 41).
CREATE TABLE IF NOT EXISTS skill_assessments (
  id            TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                          -- test | practice | project | exam | task | explanation | real_result
  score         REAL,
  level_before  INTEGER,
  level_after   INTEGER,
  evidence_type TEXT,
  evidence_ref  TEXT,
  notes         TEXT,
  assessed_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessments_skill ON skill_assessments(skill_id, assessed_at);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  domain     TEXT,
  summary    TEXT,
  mastery    INTEGER NOT NULL DEFAULT 0,                -- 0..100
  status     TEXT NOT NULL DEFAULT 'unknown',           -- unknown | learning | practiced | mastered | gap
  parent_id  TEXT REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge_nodes(domain, deleted);

CREATE TABLE IF NOT EXISTS knowledge_relationships (
  id           TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL DEFAULT 'related',         -- prerequisite | related | part_of | applies
  weight       REAL NOT NULL DEFAULT 0.5,
  note         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (from_node_id, to_node_id, relation)
);

CREATE TABLE IF NOT EXISTS knowledge_node_links (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                            -- goal | skill | learning_topic | project | task
  entity_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (node_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_entity ON knowledge_node_links(entity_type, entity_id);

-- ───────────────────────────────────────── projects ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  goal_id          TEXT REFERENCES goals(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active',      -- idea | active | paused | done | archived | cancelled
  priority         TEXT NOT NULL DEFAULT 'P2',
  start_date       TEXT,
  deadline         TEXT,
  progress         REAL NOT NULL DEFAULT 0,
  health           TEXT,                                -- on_track | at_risk | stalled | blocked
  last_activity_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  deleted          INTEGER NOT NULL DEFAULT 0,
  sync_state       TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, deleted, priority);

CREATE TABLE IF NOT EXISTS project_milestones (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',         -- pending | in_progress | done | skipped
  weight       REAL NOT NULL DEFAULT 1,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id, position);

CREATE TABLE IF NOT EXISTS project_skills (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'builds',            -- builds | requires
  created_at TEXT NOT NULL,
  UNIQUE (project_id, skill_id)
);

-- ───────────────────────────────────────── learning ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learning_paths (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  skill_id     TEXT REFERENCES skills(id) ON DELETE SET NULL,
  goal_id      TEXT REFERENCES goals(id) ON DELETE SET NULL,
  target_level INTEGER,
  status       TEXT NOT NULL DEFAULT 'active',          -- active | paused | completed | archived
  progress     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_paths_status ON learning_paths(status, deleted);

CREATE TABLE IF NOT EXISTS learning_topics (
  id                TEXT PRIMARY KEY,
  path_id           TEXT NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  summary           TEXT,
  outcome           TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  depends_on        TEXT,                               -- JSON array of topic ids
  estimated_minutes INTEGER NOT NULL DEFAULT 45,
  status            TEXT NOT NULL DEFAULT 'pending',    -- pending | available | in_progress | done | skipped
  resources_json    TEXT,
  progress          REAL NOT NULL DEFAULT 0,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  deleted           INTEGER NOT NULL DEFAULT 0,
  sync_state        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_topics_path ON learning_topics(path_id, position);
CREATE INDEX IF NOT EXISTS idx_topics_status ON learning_topics(status, deleted);

CREATE TABLE IF NOT EXISTS learning_progress (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT REFERENCES learning_topics(id) ON DELETE CASCADE,
  path_id    TEXT REFERENCES learning_paths(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                             -- study | practice | test | recall | explanation | project
  minutes    INTEGER NOT NULL DEFAULT 0,
  score      REAL,
  notes      TEXT,
  at         TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_progress_topic ON learning_progress(topic_id, at);
CREATE INDEX IF NOT EXISTS idx_learning_progress_path ON learning_progress(path_id, at);

-- SM-2 style spaced repetition queue (req. 39).
CREATE TABLE IF NOT EXISTS learning_reviews (
  id               TEXT PRIMARY KEY,
  topic_id         TEXT NOT NULL REFERENCES learning_topics(id) ON DELETE CASCADE,
  card_key         TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  answer           TEXT,
  due_at           TEXT NOT NULL,
  interval_days    REAL NOT NULL DEFAULT 0,
  ease             REAL NOT NULL DEFAULT 2.5,
  repetitions      INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  status           TEXT NOT NULL DEFAULT 'active',      -- active | mastered | suspended
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  deleted          INTEGER NOT NULL DEFAULT 0,
  sync_state       TEXT NOT NULL DEFAULT 'local',
  UNIQUE (topic_id, card_key)
);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON learning_reviews(due_at, status, deleted);

-- ───────────────────────────────────────── tasks & calendar ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  notes               TEXT,
  kind                TEXT NOT NULL DEFAULT 'generic',  -- generic | learning | practice | review | project | health | errand | work
  status              TEXT NOT NULL DEFAULT 'todo',     -- todo | scheduled | in_progress | done | cancelled | postponed
  priority            TEXT NOT NULL DEFAULT 'P2',       -- P0 | P1 | P2 | P3
  energy              TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high
  estimated_minutes   INTEGER NOT NULL DEFAULT 30,
  actual_minutes      INTEGER NOT NULL DEFAULT 0,
  goal_id             TEXT REFERENCES goals(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  skill_id            TEXT REFERENCES skills(id) ON DELETE SET NULL,
  learning_topic_id   TEXT REFERENCES learning_topics(id) ON DELETE SET NULL,
  due_date            TEXT,
  due_time            TEXT,
  scheduled_date      TEXT,
  scheduled_start     TEXT,
  scheduled_end       TEXT,
  completed_at        TEXT,
  postponed_count     INTEGER NOT NULL DEFAULT 0,
  postpone_reason     TEXT,
  strict              INTEGER NOT NULL DEFAULT 0,
  recurrence          TEXT,                             -- daily | weekdays | weekly:<dow> | monthly:<day> | null
  last_done_at        TEXT,
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  deleted             INTEGER NOT NULL DEFAULT 0,
  sync_state          TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_date, status, deleted);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date, status, deleted);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, deleted);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id, status);

-- Every transition + the reason behind it (strict mode, req. 32).
CREATE TABLE IF NOT EXISTS task_history (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,                            -- created | scheduled | started | completed | postponed | cancelled | rescheduled | deleted | reason_given | minimal_version_offered
  from_status TEXT,
  to_status   TEXT,
  reason      TEXT,                                     -- unexpected_event | lack_of_time | fatigue | illness | procrastination | other
  note        TEXT,
  actor       TEXT NOT NULL DEFAULT 'user',             -- user | ai | system | sync
  at          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id, at);

CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'other',       -- class | work | meeting | commute | errand | training | social | health | exam | free | other
  location         TEXT,
  notes            TEXT,
  day_key          TEXT NOT NULL,                       -- local YYYY-MM-DD (indexed hot path)
  starts_at        TEXT NOT NULL,                       -- local sortable datetime or UTC ISO for all-day
  ends_at          TEXT NOT NULL,
  all_day          INTEGER NOT NULL DEFAULT 0,
  priority         TEXT NOT NULL DEFAULT 'normal',      -- critical | normal | flexible
  source           TEXT NOT NULL DEFAULT 'manual',      -- manual | ai | import | external
  reminder_minutes INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  deleted          INTEGER NOT NULL DEFAULT 0,
  sync_state       TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_events_day ON calendar_events(day_key, deleted, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_range ON calendar_events(starts_at, ends_at);

-- ───────────────────────────────────────── memory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,                      -- fact | preference | goal_change | decision | event | insight | behavior | skill_evidence
  section           TEXT,
  content           TEXT NOT NULL,
  importance        REAL NOT NULL DEFAULT 0.5,
  confidence        TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | inferred | uncertain
  source            TEXT NOT NULL DEFAULT 'user_provided', -- user_provided | ai_inferred | system_observed
  entity_type       TEXT,
  entity_id         TEXT,
  tags              TEXT,                               -- JSON array
  embedding         TEXT,                               -- JSON array of floats (nullable when no embed provider)
  valid_from        TEXT,
  valid_until       TEXT,
  superseded_by     TEXT REFERENCES memories(id) ON DELETE SET NULL,
  needs_confirmation INTEGER NOT NULL DEFAULT 0,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  deleted           INTEGER NOT NULL DEFAULT 0,
  sync_state        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_memories_section ON memories(section, deleted, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(deleted, superseded_by, importance DESC);

CREATE TABLE IF NOT EXISTS memory_sources (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,                            -- conversation | onboarding | interview | task | review | import | observation
  source_id   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id);

-- ───────────────────────────────────────── conversations ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  title           TEXT,
  kind            TEXT NOT NULL DEFAULT 'mentor',       -- mentor | onboarding | interview | review
  summary         TEXT,
  started_at      TEXT NOT NULL,
  last_message_at TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0,
  tokens_total    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  deleted         INTEGER NOT NULL DEFAULT 0,
  sync_state      TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(last_message_at DESC, deleted);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,                        -- user | assistant | system | tool
  content         TEXT NOT NULL,
  tool_calls      TEXT,                                 -- JSON array of {name, args, result, ok}
  tool_name       TEXT,
  provider        TEXT,
  model           TEXT,
  tokens          INTEGER,
  latency_ms      INTEGER,
  created_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  deleted         INTEGER NOT NULL DEFAULT 0,
  sync_state      TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- ───────────────────────────────────────── news ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL DEFAULT 'rss',          -- rss | atom | api
  category        TEXT NOT NULL DEFAULT 'world',
  language        TEXT NOT NULL DEFAULT 'en',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  etag            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  deleted         INTEGER NOT NULL DEFAULT 0,
  sync_state      TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS news_items (
  id               TEXT PRIMARY KEY,
  source_id        TEXT REFERENCES news_sources(id) ON DELETE SET NULL,
  external_id      TEXT,
  url              TEXT,
  title            TEXT NOT NULL,
  summary          TEXT,
  what_happened    TEXT,
  why_it_matters   TEXT,
  context          TEXT,
  impact           TEXT,
  category         TEXT NOT NULL DEFAULT 'world',       -- world | technology | ai | economy | business | science | geopolitics | programming
  urgency          TEXT NOT NULL DEFAULT 'digest',      -- urgent | digest | none
  relevance        REAL NOT NULL DEFAULT 0,
  day_key          TEXT,
  published_at     TEXT,
  fetched_at       TEXT NOT NULL,
  read_at          TEXT,
  saved_at         TEXT,
  structured       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  deleted          INTEGER NOT NULL DEFAULT 0,
  sync_state       TEXT NOT NULL DEFAULT 'local',
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_news_recent ON news_items(published_at DESC, deleted);
CREATE INDEX IF NOT EXISTS idx_news_category ON news_items(category, urgency, deleted);
CREATE INDEX IF NOT EXISTS idx_news_day ON news_items(day_key, deleted);

-- ───────────────────────────────────────── notifications ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                           -- daily_plan | schedule_start | task_reminder | learning_review | important_news | goal_review | project_deadline | mentor_message | daily_digest
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  context_json TEXT,
  importance   REAL NOT NULL DEFAULT 0.5,
  channel      TEXT NOT NULL DEFAULT 'local',           -- local | push | in_app
  scheduled_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at      TEXT,
  cancelled_at TEXT,
  action_type  TEXT,                                    -- open_task | open_event | open_goal | open_news | open_mentor
  entity_type  TEXT,
  entity_id    TEXT,
  budget_day   TEXT,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(scheduled_at, delivered_at, cancelled_at, deleted);
CREATE INDEX IF NOT EXISTS idx_notifications_budget ON notifications(budget_day, delivered_at);
CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key);

CREATE TABLE IF NOT EXISTS notification_preferences (
  type         TEXT PRIMARY KEY,                        -- concrete type or '*' for global defaults
  enabled      INTEGER NOT NULL DEFAULT 1,
  channels     TEXT NOT NULL DEFAULT '["local","in_app"]',
  quiet_start  TEXT,                                    -- "22:30"
  quiet_end    TEXT,                                    -- "07:30"
  daily_budget INTEGER NOT NULL DEFAULT 6,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);

-- ───────────────────────────────────────── progress, reviews, personalization (derived) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS progress_snapshots (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,                           -- day | week | month
  period_key   TEXT NOT NULL,                           -- 2026-09-08 | 2026-W37 | 2026-09
  metrics_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (scope, period_key)
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  id                    TEXT PRIMARY KEY,
  day                   TEXT NOT NULL UNIQUE,
  completed_json        TEXT,
  pending_json          TEXT,
  schedule_changes_json TEXT,
  progress_json         TEXT,
  achievements_json     TEXT,
  goal_changes_json     TEXT,
  events_json           TEXT,
  projects_json         TEXT,
  learning_json         TEXT,
  metrics_json          TEXT,
  summary               TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  deleted               INTEGER NOT NULL DEFAULT 0,
  sync_state            TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id           TEXT PRIMARY KEY,
  week_start   TEXT NOT NULL UNIQUE,
  went_well    TEXT,
  went_wrong   TEXT,
  changed      TEXT,
  blockers     TEXT,
  improved     TEXT,
  next_week    TEXT,
  analysis     TEXT,
  patterns     TEXT,
  metrics_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  sync_state   TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS monthly_reviews (
  id                TEXT PRIMARY KEY,
  month             TEXT NOT NULL UNIQUE,
  goals_json        TEXT,
  skills_json       TEXT,
  projects_json     TEXT,
  priority_changes  TEXT,
  strategy_proposal TEXT,
  metrics_json      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  deleted           INTEGER NOT NULL DEFAULT 0,
  sync_state        TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS behavior_signals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                           -- task_completed | task_postponed | task_cancelled | review_graded | focus_slot | plan_accuracy | study_hour | strict_reason
  subject_type TEXT,
  subject_id   TEXT,
  value_json   TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1,
  observed_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_kind ON behavior_signals(kind, observed_at);

CREATE TABLE IF NOT EXISTS personalization_profile (
  key            TEXT PRIMARY KEY,                      -- best_focus_hours | realistic_daily_load | preferred_formats | postponed_patterns | plan_accuracy | completion_rate | preferred_free_time
  value_json     TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence     TEXT NOT NULL DEFAULT 'uncertain',
  updated_at     TEXT NOT NULL
);

-- ───────────────────────────────────────── sync & audit ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_queue (
  operation_id   TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  operation_type TEXT NOT NULL,                         -- create | update | delete
  payload        TEXT NOT NULL,
  base_version   INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  priority       INTEGER NOT NULL DEFAULT 0,
  device_id      TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending',       -- pending | in_flight | synchronized | conflict | failed
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(sync_status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_cursors (
  entity_type     TEXT PRIMARY KEY,
  last_pulled_seq TEXT,
  last_pushed_at  TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  field          TEXT,
  local_payload  TEXT NOT NULL,
  remote_payload TEXT NOT NULL,
  base_version   INTEGER NOT NULL DEFAULT 0,
  server_version INTEGER NOT NULL DEFAULT 0,
  critical       INTEGER NOT NULL DEFAULT 0,
  resolution     TEXT,                                  -- merged | local_wins | remote_wins | user_choice | delete_wins
  resolved_at    TEXT,
  resolved_by    TEXT,
  detected_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON sync_conflicts(resolved_at, detected_at);

CREATE TABLE IF NOT EXISTS change_log (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  action         TEXT NOT NULL,                         -- create | update | delete | restore | assess | schedule | complete | postpone | import | migration
  before_json    TEXT,
  after_json     TEXT,
  actor          TEXT NOT NULL DEFAULT 'user',          -- user | ai | system | sync | import
  reason         TEXT,
  correlation_id TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id, at);
CREATE INDEX IF NOT EXISTS idx_change_log_at ON change_log(at);

CREATE TABLE IF NOT EXISTS backups (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                          -- auto | manual | pre_migration | pre_import | pre_account_delete | export
  format        TEXT NOT NULL DEFAULT 'sqlite',         -- sqlite | json
  path          TEXT,
  checksum      TEXT,
  size_bytes    INTEGER,
  entity_counts TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'ok',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_recent ON backups(created_at DESC);
`;
