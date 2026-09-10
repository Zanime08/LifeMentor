import type { Database, IntegrityReport } from '../db/database';
import type { Repos } from '../db/repos';
import type { AppStateRow } from '../domain/types';
import type { SettingsService } from './settings';
import type { SyncEngine } from './sync';
import type { BackupService } from './backup';
import type { SnapshotService } from './progress';
import { newId } from '../util/id';
import { addMinutes, dayKey, nowIso } from '../util/time';
import { createLogger } from '../util/logging';

const log = createLogger('crash');

/**
 * Crash recovery (req. 13, 94).
 *
 * Startup sequence from docs/04 §2, in order:
 *  1. integrity check (quick, full when something looks wrong);
 *  2. WAL recovery — automatic in SQLite, verified here;
 *  3. foreign-key violations → quarantined into `change_log` and repaired;
 *  4. schema version verified against the build (migrations run in `Database.open`,
 *     and a pre-migration backup can be taken before that when a service is supplied);
 *  5. `sync_queue` rows stuck `in_flight` → back to `pending` (never acknowledged);
 *  6. `app_state` → unsent drafts, last route, in-progress onboarding step returned to the UI;
 *  7. tasks left `in_progress` with a stale timestamp → reported to the user, never reset silently;
 *  8. daily snapshot re-scheduled when the last one is older than today.
 *
 * After an ordinary crash the user does not have to restore anything.
 */

export interface RecoveryDeps {
  db: Database;
  repos: Repos;
  settings: SettingsService;
  sync?: SyncEngine;
  backup?: BackupService;
  snapshots?: SnapshotService;
  deviceId: string;
  /** Tasks untouched for longer than this are reported as abandoned mid-work. */
  staleInProgressMinutes?: number;
}

export interface RecoveryAction {
  step: string;
  status: 'ok' | 'repaired' | 'skipped' | 'failed';
  detail: string;
  count?: number;
}

export interface RecoveryIssue {
  kind: 'integrity' | 'orphan' | 'stale_task' | 'schema' | 'sync' | 'snapshot';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data?: Record<string, unknown>;
}

export interface RecoveryReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  actions: RecoveryAction[];
  issues: RecoveryIssue[];
  integrity: IntegrityReport | null;
  state: { drafts: Record<string, unknown>; lastRoute: string | null; onboarding: string | null };
  needsUserAttention: RecoveryIssue[];
}

const DRAFT_PREFIX = 'draft:';

export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  /** Run the whole startup recovery sequence. Safe to call on every launch. */
  async startup(): Promise<RecoveryReport> {
    const started = Date.now();
    const startedAt = nowIso();
    const actions: RecoveryAction[] = [];
    const issues: RecoveryIssue[] = [];

    const integrity = await this.checkIntegrity(actions, issues);
    if (integrity && !integrity.ok) {
      await this.repairForeignKeys(actions, issues);
      const recheck = await this.deps.db.integrityCheck({ full: true });
      actions.push({
        step: 'integrity re-check', status: recheck.ok ? 'repaired' : 'failed',
        detail: recheck.ok ? 'database is consistent after repairs' : `still failing: ${recheck.quickCheck}, ${recheck.foreignKeyViolations.length} FK violations`,
      });
      if (!recheck.ok) {
        issues.push({
          kind: 'integrity', severity: 'critical',
          message: 'The database still reports problems after automatic repair. Restore the latest backup before continuing.',
          data: { quickCheck: recheck.quickCheck, violations: recheck.foreignKeyViolations.length },
        });
      }
    }

    await this.verifySchema(actions, issues);
    await this.resetStuckSync(actions, issues);
    const state = await this.readAppState(actions);
    await this.reportStaleTasks(actions, issues);
    await this.ensureSnapshot(actions, issues);

    const ok = !issues.some((issue) => issue.severity === 'critical');
    const report: RecoveryReport = {
      startedAt, finishedAt: nowIso(), durationMs: Date.now() - started, ok, actions, issues, integrity, state,
      needsUserAttention: issues.filter((issue) => issue.severity !== 'info'),
    };
    if (issues.length) log.warn('startup recovery found issues', { issues: issues.map((i) => `${i.kind}:${i.severity}`) });
    else log.info('startup recovery clean', { ms: report.durationMs });
    return report;
  }

  /** Take a backup before a risky operation (migration, import, restore). */
  async protectBeforeRiskyOperation(kind: 'pre_migration' | 'pre_import' | 'manual', note?: string): Promise<string | null> {
    if (!this.deps.backup) return null;
    try {
      const record = await this.deps.backup.createBackup(kind, note);
      return record.id;
    } catch (error) {
      log.error('protective backup failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /** Quick health probe for the diagnostics screen without touching anything. */
  async diagnose(): Promise<{ integrity: IntegrityReport; counts: Record<string, number>; syncPending: number; issues: RecoveryIssue[] }> {
    const integrity = await this.deps.db.integrityCheck({ full: true });
    const issues: RecoveryIssue[] = [];
    if (!integrity.ok) issues.push({ kind: 'integrity', severity: 'critical', message: `quick_check=${integrity.quickCheck}, ${integrity.foreignKeyViolations.length} foreign-key violations` });
    if (integrity.schemaVersion !== integrity.expectedSchemaVersion) {
      issues.push({ kind: 'schema', severity: 'warning', message: `schema ${integrity.schemaVersion} ≠ expected ${integrity.expectedSchemaVersion}` });
    }
    const counts: Record<string, number> = {};
    for (const repo of this.deps.repos.syncedRepos()) counts[repo.entityType] = await repo.count({});
    const syncPending = await this.deps.repos.syncQueue.count({ sync_status: { op: 'in', value: ['pending', 'in_flight', 'conflict'] } });
    if (syncPending > 500) issues.push({ kind: 'sync', severity: 'info', message: `${syncPending} operations waiting to sync` });
    return { integrity, counts, syncPending, issues };
  }

  // ─────────────────────────── app state (drafts, last route) ───────────────────────────
  async saveDraft(key: string, value: unknown): Promise<void> {
    await this.putState(`${DRAFT_PREFIX}${key}`, JSON.stringify(value ?? null));
  }

  async readDraft<T = unknown>(key: string): Promise<T | null> {
    const row = await this.deps.repos.appState.byId(`${DRAFT_PREFIX}${key}`);
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  async clearDraft(key: string): Promise<void> {
    await this.deps.repos.appState.hardDelete(`${DRAFT_PREFIX}${key}`, { actor: 'system', sync: false, audit: false });
  }

  async drafts(): Promise<Record<string, unknown>> {
    const rows = await this.deps.repos.appState.find({}, { limit: 200 });
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      if (!row.key.startsWith(DRAFT_PREFIX)) continue;
      try { out[row.key.slice(DRAFT_PREFIX.length)] = JSON.parse(row.value); } catch { out[row.key.slice(DRAFT_PREFIX.length)] = row.value; }
    }
    return out;
  }

  async setLastRoute(route: string): Promise<void> { await this.putState('last_route', route); }
  async lastRoute(): Promise<string | null> { return (await this.deps.repos.appState.byId('last_route'))?.value ?? null; }

  private async putState(key: string, value: string): Promise<void> {
    const existing = await this.deps.repos.appState.byId(key);
    if (existing) await this.deps.repos.appState.update(key, { value, updated_at: nowIso() } as never, { actor: 'system', sync: false, audit: false });
    else await this.deps.repos.appState.insert({ key, value, updated_at: nowIso() } as never, { actor: 'system', sync: false, audit: false });
  }

  private async readAppState(actions: RecoveryAction[]): Promise<RecoveryReport['state']> {
    const drafts = await this.drafts();
    const lastRoute = await this.lastRoute();
    const session = await this.deps.repos.onboardingSessions.findOne(
      { status: { op: 'in', value: ['in_progress', 'awaiting_interview', 'awaiting_confirmation'] } },
      { orderBy: { started_at: 'desc' } },
    );
    actions.push({
      step: 'app state', status: 'ok',
      detail: `${Object.keys(drafts).length} saved draft(s), last route ${lastRoute ?? 'none'}, onboarding ${session ? `${session.stage}` : 'not started'}`,
      count: Object.keys(drafts).length,
    });
    return { drafts, lastRoute, onboarding: session?.stage ?? null };
  }

  // ─────────────────────────── steps ───────────────────────────
  private async checkIntegrity(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<IntegrityReport | null> {
    try {
      const integrity = await this.deps.db.integrityCheck();
      actions.push({
        step: 'integrity check', status: integrity.ok ? 'ok' : 'repaired',
        detail: `quick_check=${integrity.quickCheck}, journal=${integrity.journalMode}, fk violations=${integrity.foreignKeyViolations.length}`,
        count: integrity.foreignKeyViolations.length,
      });
      if (!integrity.ok) {
        issues.push({
          kind: integrity.foreignKeyViolations.length ? 'orphan' : 'integrity',
          severity: 'warning',
          message: integrity.foreignKeyViolations.length
            ? `${integrity.foreignKeyViolations.length} row(s) reference a parent that no longer exists`
            : `quick_check reported "${integrity.quickCheck}"`,
        });
      }
      return integrity;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actions.push({ step: 'integrity check', status: 'failed', detail: message });
      issues.push({ kind: 'integrity', severity: 'critical', message: `Integrity check could not run: ${message}` });
      return null;
    }
  }

  /**
   * Orphan rows cannot be kept (foreign keys are always enforced), so each one is
   * written to `change_log` with its full payload before deletion — recoverable from
   * the journal or from any backup taken before the crash.
   */
  async repairForeignKeys(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<number> {
    const violations = await this.deps.db.all<{ table: string; rowid: number | string; parent: number | string; fkid: number | string }>('PRAGMA foreign_key_check');
    if (!violations.length) {
      actions.push({ step: 'foreign-key repair', status: 'ok', detail: 'no orphan rows' });
      return 0;
    }
    let quarantined = 0;
    for (const violation of violations) {
      const rows = await this.deps.db.all<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(violation.table)} WHERE rowid = ?`, [violation.rowid]);
      const row = rows[0];
      await this.deps.db.transaction(async () => {
        await this.deps.repos.changeLog.insert({
          id: newId(), entity_type: violation.table, entity_id: String(row?.id ?? violation.rowid), action: 'delete',
          before_json: row ? JSON.stringify(row) : null, after_json: null, actor: 'system',
          reason: `quarantined orphan row (parent table #${violation.parent}, fk #${violation.fkid})`, at: nowIso(),
        } as never, { actor: 'system', sync: false, audit: false });
        await this.deps.db.run(`DELETE FROM ${quoteIdent(violation.table)} WHERE rowid = ?`, [violation.rowid]);
      }, 'quarantine-orphan');
      quarantined += 1;
    }
    actions.push({ step: 'foreign-key repair', status: 'repaired', detail: `${quarantined} orphan row(s) quarantined into change_log and removed`, count: quarantined });
    issues.push({
      kind: 'orphan', severity: 'warning',
      message: `${quarantined} orphan row(s) were removed. Their content is preserved in the change journal.`,
      data: { tables: [...new Set(violations.map((v) => v.table))] },
    });
    return quarantined;
  }

  private async verifySchema(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<void> {
    const version = await this.deps.db.readSchemaVersion();
    const expected = (await this.deps.db.integrityCheck()).expectedSchemaVersion;
    if (version === expected) {
      actions.push({ step: 'schema version', status: 'ok', detail: `schema v${version}` });
      return;
    }
    actions.push({ step: 'schema version', status: 'failed', detail: `schema v${version}, build expects v${expected}` });
    issues.push({
      kind: 'schema', severity: version > expected ? 'critical' : 'warning',
      message: version > expected
        ? `This database was written by a newer LifeMentor build (schema v${version}). Update the app before continuing.`
        : `Database schema v${version} is older than expected v${expected}; migrations did not complete.`,
    });
  }

  private async resetStuckSync(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<void> {
    if (!this.deps.sync) {
      const stuck = await this.deps.repos.syncQueue.count({ sync_status: 'in_flight' });
      if (stuck) {
        await this.deps.db.run(`UPDATE sync_queue SET sync_status = 'pending', updated_at = ? WHERE sync_status = 'in_flight'`, [nowIso()]);
        actions.push({ step: 'sync queue', status: 'repaired', detail: `${stuck} in-flight operation(s) reset to pending`, count: stuck });
      } else {
        actions.push({ step: 'sync queue', status: 'ok', detail: 'nothing in flight' });
      }
      return;
    }
    const reset = await this.deps.sync.resetInFlight();
    actions.push({ step: 'sync queue', status: reset ? 'repaired' : 'ok', detail: reset ? `${reset} in-flight operation(s) reset to pending` : 'nothing in flight', count: reset });
    const failed = await this.deps.repos.syncQueue.count({ sync_status: 'failed' });
    if (failed) issues.push({ kind: 'sync', severity: 'info', message: `${failed} change(s) were rejected by the server and need attention in Sync status.` });
  }

  private async reportStaleTasks(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<void> {
    const threshold = addMinutes(new Date(), -(this.deps.staleInProgressMinutes ?? 120)).toISOString();
    const stale = await this.deps.repos.tasks.find(
      { status: 'in_progress', updated_at: { op: 'lt', value: threshold } },
      { limit: 50 },
    );
    if (!stale.length) {
      actions.push({ step: 'in-progress tasks', status: 'ok', detail: 'none left over' });
      return;
    }
    // Reported, never silently reset (req. 13): only the user knows whether the work happened.
    actions.push({ step: 'in-progress tasks', status: 'skipped', detail: `${stale.length} task(s) were left in progress — asking the user`, count: stale.length });
    issues.push({
      kind: 'stale_task', severity: 'info',
      message: `${stale.length} task(s) were still marked in progress when the app closed: ${stale.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}. Did you finish them?`,
      data: { taskIds: stale.map((t) => t.id) },
    });
  }

  private async ensureSnapshot(actions: RecoveryAction[], issues: RecoveryIssue[]): Promise<void> {
    const flags = await this.deps.settings.all();
    const today = dayKey();
    // `last_snapshot_check_day` — "we already looked for missed snapshots today". It must not be
    // `last_daily_snapshot_day`, which means "today's end-of-day snapshot was taken": a morning
    // startup would otherwise suppress the evening snapshot for the rest of the day.
    if (flags.flags.last_snapshot_check_day === today) {
      actions.push({ step: 'daily snapshot', status: 'ok', detail: `already checked for ${today}` });
      return;
    }
    if (!this.deps.snapshots) {
      actions.push({ step: 'daily snapshot', status: 'skipped', detail: 'snapshot service not available' });
      return;
    }
    try {
      const result = await this.deps.snapshots.ensureUpToDate({ actor: 'system', deviceId: this.deps.deviceId });
      actions.push({ step: 'daily snapshot', status: 'ok', detail: result.created.length ? `created ${result.created.join(', ')}` : `up to date (checked ${result.checked.join(', ')})` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actions.push({ step: 'daily snapshot', status: 'failed', detail: message });
      issues.push({ kind: 'snapshot', severity: 'warning', message: `Daily snapshot could not be created: ${message}` });
    }
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

export type { AppStateRow };
