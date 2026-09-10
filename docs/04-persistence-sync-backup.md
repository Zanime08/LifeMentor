# Persistence, Crash Safety, Sync, Backup (Phases 4, 16, 17)

## 1. Transactional saving (req. 8, 9, 94)

Every mutation is: **validate → BEGIN → write entity → write change_log → enqueue sync → COMMIT →
notify UI → (later) push to server**.

```ts
// packages/core/src/db/transaction.ts
await db.transaction(() => {
  repo.update(task);              // version = version + 1, updated_at = now
  changeLog.record({...});        // before / after / actor / reason
  syncQueue.enqueue({...});       // operation for later push
});                               // COMMIT here — data is durable before the UI is told
```

Consequences:
* if the process is killed after COMMIT, the change is there;
* if it is killed during the transaction, SQLite rolls back — no half-written state;
* the UI only shows "saved" after COMMIT succeeds (`Result.ok`), never optimistically-without-record;
* there is no "save everything at end of day" path anywhere in the codebase.

**Concurrency contract.** There is one connection and therefore one transaction at a time.
`db.transaction()` distinguishes two situations:

* **nested** (a service calls another service that opens a transaction from the same operation) —
  joins with `SAVEPOINT`, only the outermost `COMMIT` reaches the disk, so composite operations
  stay atomic;
* **concurrent** (two independent screens/tools fire work in the same tick) — this must not
  happen: a joined transaction shares its owner's commit *and* rollback, so a failure in the owner
  would discard a sibling's already-acknowledged writes. Composite or repeatedly-triggered
  operations take a turn through `db.runExclusive()` (call order, failures never block the queue)
  or a service-level lock — `PlannerService.buildDay()` is serialised this way because the
  dashboard, the Today screen, onboarding and the mentor's `plan_day` tool can all request a plan
  within the same second.

`Database.transaction()` claims the connection *synchronously* before its first `await`; without
that, two same-tick callers both observed "no transaction running" and SQLite answered the second
`BEGIN` with `cannot start a transaction within a transaction`.

## 2. Crash recovery on startup (req. 13)

`RecoveryService.startup()` runs before the first screen:
1. Open DB with WAL + busy timeout; run `PRAGMA quick_check` (full `integrity_check` on suspicion).
2. If `-wal`/`-shm` exist, SQLite recovers automatically (that is what WAL is for).
3. `PRAGMA foreign_key_check` → orphan rows are quarantined into `change_log` + repaired.
4. Pending migrations → backup the file → apply → verify → continue (or restore backup and report).
5. `sync_queue` rows stuck in `in_flight` → reset to `pending` (they were never acknowledged).
6. `app_state` → restore unsent form drafts, last route, in-progress onboarding step.
7. `tasks.status='in_progress'` with a stale `updated_at` → offered to the user, not silently reset.
8. Schedule the daily snapshot job if the last one is older than the current day.

The user never has to "restore" anything after an ordinary crash.

## 3. Journal of changes (req. 12)

`change_log` keeps `before`/`after` JSON for critical entities (goals, tasks, events, skills,
profile fields, memories, settings, projects, strategy). Retention: 180 days for routine changes,
permanent for goal/strategy changes (`strategy_changes` is append-only and never pruned).

## 4. Daily snapshot (req. 11)

`SnapshotService.createDailySnapshot(day)` runs at day rollover (and on demand / before risky ops):
completed tasks, uncompleted tasks + why, schedule changes, progress deltas, achievements,
goal changes, important events, active project state, learning stats, and an AI-written summary.
Snapshots are **derived** data: they exist for history, statistics, recovery and AI context —
never as the primary store.

## 5. Sync model (req. 14, 60, 61, 62)

**Incremental, entity-level, version-based, last-writer-with-review.**

Push (client → server):
```
POST /v1/sync/push { device_id, operations: [{ operation_id, entity_type, entity_id,
                       operation_type, base_version, version, payload, updated_at }] }
→ server validates auth + schema, applies per-entity, returns
  { results: [{ operation_id, status: applied|conflict|rejected, server_version, remote_payload? }] }
→ client marks queue rows `synchronized` and updates local `version`/`sync_state`.
```
Pull (server → client):
```
GET /v1/sync/pull?since=<cursor>&device_id=...&limit=200
→ { changes: [{entity_type, entity_id, version, payload, deleted, updated_at, origin_device}], cursor }
→ applied in one transaction, per entity, with conflict detection.
```
Cursors are stored per entity type in `sync_cursors` so pulls are incremental (never full-DB sync).
Batching: up to 200 ops/request; exponential backoff with jitter on failure; queue rows keep
`attempts` + `last_error`; permanent rejection (schema/validation) is surfaced to the user, not retried forever.

Triggers: app start, network regained, after N local mutations, periodic timer, manual "Sync now".

## 6. Conflict resolution (req. 15)

Detected when `base_version < server_version` for the same entity.

| Situation | Rule |
|---|---|
| Field-disjoint changes (client changed `status`, server changed `notes`) | **Field-level merge** — both kept |
| Same field, one side is a *completion* (`status=done`) | completion wins, other change becomes a `task_history` note |
| Same field, both semantic edits | compare `updated_at`, keep newer **and** store the loser in `sync_conflicts` |
| Delete vs update | delete wins, but the updated payload is preserved in `sync_conflicts` (recoverable) |
| Goals, strategy, profile facts, memories, settings (`critical=true`) | **never silent** — create a conflict record + ask: "This was changed on two devices. Which version do you keep?" with a side-by-side diff |

Every automatic resolution writes a `change_log` entry with `actor='sync'` and the reason,
so nothing disappears without a trace.

## 7. Backup & restore (req. 16, 54, 55)

* **Automatic local backup**: after migrations, before imports, daily (rotating: keep 7 daily +
  4 weekly + 3 monthly), and on explicit user action. Implemented as a SQLite online backup
  (VACUUM INTO / byte copy under a read transaction) → `backups/lifementor-<ts>.sqlite`.
* **Export my data**: portable archive `LifeMentor-export-<date>.json` (+ optional per-domain files
  `profile.json goals.json skills.json projects.json tasks.json calendar.json memory.json
  progress.json learning.json news.json settings.json`) with a manifest
  (`format_version, app_version, schema_version, exported_at, counts, checksum`).
* **Import**: validate manifest + every record against Zod schemas → check version compatibility
  (same or older format version, else migrate) → **take a backup of the current state first** →
  show the user a diff preview (create/update/delete counts per entity) → apply in one transaction
  → integrity check → report. Import never silently overwrites: `merge` (default) or `replace` mode.
* **Restore from backup**: verify checksum + `integrity_check`, then swap files atomically
  (rename new → old, keep the previous file as `.pre-restore`).

## 8. Account deletion (req. 56)

1. Offer export (default: yes). 2. Warn with explicit consequences. 3. `DELETE /v1/account`
   (server wipes sync store, memories, backups, sessions; returns a signed deletion receipt).
4. Local: delete all rows in all user tables inside one transaction, `VACUUM`, delete DB file,
   clear secure storage tokens, reset onboarding state. 5. Log the deletion locally (no personal data).

## 9. Offline behaviour matrix (req. 60)

| Feature | Offline |
|---|---|
| View/edit tasks, calendar, goals, projects, skills, progress, memories, settings | ✅ full |
| Daily planner, rescheduling, strict-mode reasons | ✅ full (local engine) |
| Learning review queue (spaced repetition) | ✅ full |
| AI mentor | ⚠️ degraded: local heuristic provider answers + queues a "explain later" note; cloud AI when back online |
| News, digest | ⚠️ last fetched items remain readable |
| Sync, push notifications, cloud backup | ⏸ queued, resumes automatically |
