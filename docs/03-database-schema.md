# Database Design (Phase 4)

**SQLite is the working store** (req. 6). JSON is used only for export/import, backups,
diagnostic snapshots, migrations and AI payloads.

## 1. Engine settings (crash safety, req. 10)

```sql
PRAGMA journal_mode = WAL;        -- readers never block writers; crash-resistant
PRAGMA synchronous  = NORMAL;     -- durable with WAL; FULL available in "paranoid" setting
PRAGMA foreign_keys = ON;         -- referential integrity always enforced
PRAGMA busy_timeout = 5000;       -- wait instead of failing on lock contention
PRAGMA wal_autocheckpoint = 1000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -8000;        -- ~8 MB page cache
```
Applied by every driver on open (`db/connection.ts`), verified by `PRAGMA integrity_check`
and `PRAGMA foreign_key_check` at startup and by the CLI/backup tools.

## 2. Conventions

* Primary keys: **time-ordered UUID strings** generated on the client → offline creation works,
  merges are deterministic, no id collisions between devices.
* Timestamps: **UTC ISO-8601 strings** (`YYYY-MM-DDTHH:mm:ss.sssZ`) — portable, sortable, no TZ bugs.
  Day keys are local-time `YYYY-MM-DD` strings (computed with the user's timezone).
* Every synced entity carries:
  `id, created_at, updated_at, version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
   sync_state TEXT NOT NULL DEFAULT 'local'  -- local | pending | synchronized | conflict`
* Soft delete (`deleted=1`) for anything that participates in sync or history; hard delete only on
  account deletion / pruning of derived+temporary data.
* Mutations go through repositories inside an explicit transaction; the repository also writes
  `change_log` and enqueues `sync_queue` **in the same transaction** (atomicity of data + audit + sync).

## 3. Table groups

### 3.1 Meta / account / settings
`schema_meta`, `account`, `session`, `devices`, `settings` (key/value JSON, versioned, synced),
`app_state` (last opened route, draft forms → crash-safe UI restore).

### 3.2 Onboarding & user model
`onboarding_sessions`, `onboarding_answers`, `interview_questions`
(question, rationale, importance, target gap, answer, whether it changed the model),
`profile_fields` (section + key + value + `source` + `confidence` + `evidence`),
`user_model_snapshots` (the whole model at a point in time — immutable history).

### 3.3 Goals & strategy
`goals` (horizon: `long|medium|short|daily`, parent_id, priority, metric, progress, status),
`goal_relationships`, `goal_reviews`,
`strategy_items` (horizon `3-5y|1y|3mo|1mo|1w|today|now`, linked to goals),
`strategy_changes` (**immutable** `old_value / new_value / reason / date`, req. 81).

### 3.4 Skills & knowledge
`skills` (level 0–100, confidence, weak_points, last/next assessment),
`skill_assessments` (kind: `test|practice|project|exam|task|explanation`, score, level_before/after,
evidence_ref — level changes **require** an assessment row, req. 41),
`knowledge_nodes`, `knowledge_relationships` (`prerequisite|related|part_of|applies`),
`knowledge_node_links` (node ↔ goal/skill/topic/project/task).

### 3.5 Projects
`projects` (goal_id, status, priority, deadline, progress), `project_milestones`,
`project_skills`, `project_tasks` (via `tasks.project_id`).

### 3.6 Execution: tasks & calendar
`tasks` (status `todo|scheduled|in_progress|done|cancelled|postponed`, priority `P0..P3`,
energy `low|medium|high`, estimated/actual minutes, due date/time, scheduled slot, links to
goal/project/skill/learning topic, recurrence, `strict_flag`, `postpone_count`),
`task_history` (every transition + reason `unexpected_event|lack_of_time|fatigue|illness|
procrastination|other`, req. 32),
`calendar_events` (kind `class|work|meeting|commute|errand|training|social|health|exam|free|other`,
priority `critical|normal|flexible`, source `manual|ai|import`, reminder offset).

### 3.7 Learning
`learning_paths`, `learning_topics` (position, `depends_on`, estimated minutes, resources),
`learning_progress` (study/practice/test/recall events with score + minutes),
`learning_reviews` (SM-2 style: `interval_days`, `ease`, `repetitions`, `lapses`, `due_at`).

### 3.8 Memory
`memories` (kind `fact|preference|goal_change|decision|event|insight|behavior|skill_evidence`,
content, section, importance 0..1, `confidence` `confirmed|inferred|uncertain`,
`source` `user_provided|ai_inferred|system_observed`, entity link, tags, embedding vector (JSON/BLOB),
`valid_from/valid_until`, `superseded_by`, `use_count`, `last_used_at`),
`memory_sources` (provenance: conversation / onboarding / task / review / import).

### 3.9 Conversations
`conversations`, `messages` (role `user|assistant|system|tool`, tool_calls, tokens, model).

### 3.10 News
`news_sources` (feed url, category, enabled, etag, last_fetched_at),
`news_items` (external_id unique per source, category, urgency `urgent|digest|none`,
structured fields: `what_happened`, `why_it_matters`, `context`, `impact`, relevance_score,
published_at, read_at, saved_at).

### 3.11 Notifications
`notifications` (type, title, body, context, scheduled_at, delivered_at, cancelled_at,
importance, channel, entity link, `budget_day`),
`notification_preferences` (per-type enable, quiet hours, daily budget, channels).

### 3.12 Progress & reviews (derived)
`progress_snapshots` (day/week/month metrics), `daily_snapshots` (req. 11: completed/pending tasks,
schedule changes, progress, achievements, goal changes, events, project state, AI summary of the day),
`weekly_reviews`, `monthly_reviews`, `behavior_signals`, `personalization_profile`.

### 3.13 Sync & audit
`sync_queue` (`operation_id, entity_type, entity_id, operation_type, payload, base_version,
created_at, attempts, last_error, sync_status`, req. 61),
`sync_cursors` (per entity type: last pulled/pushed server sequence),
`sync_conflicts` (local vs remote payload, detected_at, resolution, resolved_by),
`change_log` (`entity_type, entity_id, action, before, after, actor user|ai|system|sync,
reason, correlation_id, at`, req. 12).

## 4. Indexes (performance, req. 96)

Hot paths are indexed, never full-scanned:
```
tasks(scheduled_date, status)            tasks(due_date, status)         tasks(project_id)
calendar_events(starts_at)               calendar_events(ends_at)
goals(status, horizon)                   goals(parent_id)
skills(domain)                           skill_assessments(skill_id, assessed_at)
memories(section, importance DESC)       memories(entity_type, entity_id)
memories(kind, updated_at)               messages(conversation_id, created_at)
news_items(published_at DESC)            news_items(category, urgency)
notifications(scheduled_at, delivered_at) sync_queue(sync_status, created_at)
change_log(entity_type, entity_id, at)   daily_snapshots(day)
learning_reviews(due_at)                 learning_topics(path_id, position)
```

## 5. Migrations

`db/migrations/NNNN_name.sql`, applied in order inside one transaction, recorded in
`schema_meta('schema_version')` and `PRAGMA user_version`. Rules:
* never destructive without a data-preserving path (add column / backfill / rebuild table),
* every migration is idempotent-guarded and reversible-in-spirit (documented rollback),
* the server refuses to run with a schema newer than it understands (`schema_meta` check),
* migrations run **before** the first user-visible screen; failures surface as a recoverable error
  with an automatic backup taken first.

## 6. What is *not* in the DB

Secrets (tokens, refresh keys) → OS secure storage via `PlatformAdapter.secureStorage`.
Large binary blobs (attachments) → filesystem/OPFS with only paths in DB.
Embeddings for very large corpora → optional vector index file; DB keeps the vector JSON for MVP.
