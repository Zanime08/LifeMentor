import { z } from 'zod';
import { Database, type DatabaseOptions } from './db/database';
import { createRepos, type Repos } from './db/repos';
import { createSqlDriver, detectDriverKind, type CreateDriverOptions } from './db/create-driver';
import type { SqlDriver } from './db/driver';
import { createDefaultPlatform, detectPlatform, type PlatformAdapter } from './platform/adapter';

import { SettingsService } from './services/settings';
import { PersonalizationService } from './services/personalization';
import { ProfileService } from './services/profile';
import { GoalService } from './services/goals';
import { TaskService, type TaskHooks } from './services/tasks';
import { CalendarService } from './services/calendar';
import { ProjectService } from './services/projects';
import { SkillService } from './services/skills';
import { LearningService } from './services/learning';
import { MemoryService, type Embedder } from './services/memory';
import { KnowledgeService } from './services/knowledge';
import { NewsService } from './services/news';
import { NotificationService } from './services/notifications';
import { MonthlyReviewService, ProgressService, SnapshotService, WeeklyReviewService } from './services/progress';
import { OnboardingService, type GoalDraft, type OnboardingAI } from './onboarding/service';
import type { GapCandidate } from './onboarding/interview';
import type { AnswersMap } from './onboarding/interview';
import { StrategyService } from './strategy/strategy';
import { HttpSyncTransport, SyncEngine, type SyncEvent, type SyncTransport } from './services/sync';
import { BackupService, type BackupStorage } from './services/backup';
import { RecoveryService, type RecoveryReport } from './services/recovery';

// The startup recovery report is part of the public app surface: clients show it to the user
// (req. 13) instead of silently discarding what was repaired.
export type { RecoveryAction, RecoveryIssue, RecoveryReport } from './services/recovery';
import type { NarrativeGenerator } from './services/progress';
import { AuthService, HttpAuthTransport, type AuthTransport } from './services/auth';
import { NodeBackupStorage, WebBackupStorage } from './platform/storage';
import { PlannerService } from './planning/planner';

import { ContextEngine } from './ai/context-engine';
import { createTools, ToolRegistry } from './ai/tools';
import { AIOrchestrator } from './ai/orchestrator';
import { ConversationStore } from './ai/conversation';
import { MentorService } from './ai/mentor';
import { createProviderChain, LocalHeuristicProvider, type ProviderConfig } from './ai/providers';
import type { AIProvider } from './ai/types';
import { hashEmbed } from './ai/providers/local';

import { addGlobalSink, createLogger, setLogLevel, type Logger, type LogLevel, type LogSink } from './util/logging';
import { newId } from './util/id';
import { AppError } from './util/result';
import { addDays, dayKey, nowIso, startOfMonth, startOfWeek } from './util/time';
const log = createLogger('app');

/** After this local hour, today's snapshot counts as "end of day" (req. 11). */
const END_OF_DAY_HOUR = 21;
/** At most one automatic backup per day (req. 16). */
const BACKUP_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** How often an open app re-checks whether the day/week/month has turned over. */
const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;

/** What one maintenance pass did (req. 11, 16, 70, 77, 78). */
export interface DailyMaintenanceReport {
  day: string;
  /** Snapshots created for days missed while the app was closed. */
  backfilled: string[];
  snapshot: boolean;
  weekly: boolean;
  monthly: boolean;
  pruned: number;
  backup: boolean;
  /** Steps that failed. The app keeps working; the user can see what did not run. */
  failed: { step: string; message: string }[];
}

/**
 * LifeMentorApp — the composition root (req. 3, 90).
 *
 * One object wires the whole system: SQLite driver → database → repositories →
 * services → planner/strategy → AI (context engine, tools, orchestrator, mentor).
 * Desktop, web and the server all build the same object with a different driver
 * and platform adapter, which is what keeps behaviour identical across
 * Windows and Android.
 */

export interface AIOptions {
  /** Ordered provider configs; the first available one answers, later ones are fallbacks. */
  providers?: ProviderConfig[];
  /** A pre-built provider (used by tests and by the server). */
  provider?: AIProvider;
  /** 'provider' = ask the model for embeddings, 'local' = offline hash embeddings, 'none' = keyword search. */
  embeddings?: 'provider' | 'local' | 'none';
  /** Keep the offline engine as the last resort when a cloud provider fails. Default true. */
  offlineFallback?: boolean;
}

export interface SyncOptions {
  /** Custom transport (tests, alternative backends). */
  transport?: SyncTransport;
  serverUrl?: string;
  /** Read the access token from the auth layer; override for a custom token source. */
  getToken?: () => Promise<string | null>;
  autoStart?: boolean;
  intervalMs?: number;
  onEvent?: (event: SyncEvent) => void;
}

export interface BackupOptions {
  storage?: BackupStorage;
  /** Directory for the Node/desktop storage implementation. */
  directory?: string;
  /** Take a backup during `bootstrap()` when none exists yet. Default true. */
  onFirstLaunch?: boolean;
}

export interface AuthOptions {
  transport?: AuthTransport;
  serverUrl?: string;
}

export interface LifeMentorOptions {
  /** Explicit driver, or options to build one. */
  driver?: SqlDriver;
  driverOptions?: Partial<CreateDriverOptions>;
  deviceId?: string;
  deviceName?: string;
  platform?: PlatformAdapter;
  ai?: AIOptions;
  logging?: { level?: LogLevel; sinks?: LogSink[] };
  taskHooks?: TaskHooks;
  /** Run the first-launch bootstrap (defaults, device registration, recovery). Default true. */
  bootstrap?: boolean;
  sync?: SyncOptions;
  backup?: BackupOptions;
  auth?: AuthOptions;
  /** Recovery runs automatically during bootstrap; disable for a read-only open. */
  recover?: boolean;
  /**
   * Time-driven housekeeping (req. 11, 16, 77, 78): end-of-day snapshot, weekly/monthly reviews,
   * retention, daily backup. On by default — the user must not have to press a button for these.
   */
  maintenance?: { enabled?: boolean; intervalMs?: number };
}

export interface AppServices {
  settings: SettingsService;
  personalization: PersonalizationService;
  profile: ProfileService;
  goals: GoalService;
  tasks: TaskService;
  calendar: CalendarService;
  projects: ProjectService;
  skills: SkillService;
  learning: LearningService;
  memory: MemoryService;
  knowledge: KnowledgeService;
  news: NewsService;
  notifications: NotificationService;
  progress: ProgressService;
  snapshots: SnapshotService;
  weeklyReviews: WeeklyReviewService;
  monthlyReviews: MonthlyReviewService;
  strategy: StrategyService;
  planner: PlannerService;
  onboarding: OnboardingService;
  backup: BackupService;
  recovery: RecoveryService;
  auth: AuthService;
  /** Null until a sync transport/server URL is configured. */
  sync: SyncEngine | null;
}

export interface AppAI {
  provider: AIProvider;
  tools: ToolRegistry;
  context: ContextEngine;
  conversations: ConversationStore;
  orchestrator: AIOrchestrator;
  mentor: MentorService;
  embedder: Embedder | null;
  isOffline: boolean;
}

export interface AppHealth {
  ok: boolean;
  deviceId: string;
  platform: string;
  driver: string;
  database: string;
  schemaVersion: number;
  integrity: Awaited<ReturnType<Database['integrityCheck']>>;
  ai: { provider: string; offline: boolean; capabilities: AIProvider['capabilities'] };
  onboarding: { completed: boolean; modelConfirmed: boolean };
  counts: Record<string, number>;
  checkedAt: string;
}

export class LifeMentorApp {
  readonly db: Database;
  readonly repos: Repos;
  readonly deviceId: string;
  readonly platform: PlatformAdapter;
  readonly logger: Logger;
  readonly services: AppServices;
  readonly ai: AppAI;
  /** Result of the startup recovery sequence (null when bootstrap/recovery was skipped). */
  recoveryReport: RecoveryReport | null = null;
  /** What the last maintenance pass did — shown in diagnostics, never hidden (req. 96). */
  lastMaintenanceReport: DailyMaintenanceReport | null = null;
  private networkUnsubscribe: (() => void) | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private lastMaintenanceAt: string | null = null;
  private maintenanceFirstPass: Promise<DailyMaintenanceReport | null> = Promise.resolve(null);

  private constructor(
    db: Database,
    repos: Repos,
    deviceId: string,
    platform: PlatformAdapter,
    services: AppServices,
    ai: AppAI,
    maintenance: { enabled?: boolean; intervalMs?: number } = {},
  ) {
    this.db = db;
    this.repos = repos;
    this.deviceId = deviceId;
    this.platform = platform;
    this.logger = log;
    this.services = services;
    this.ai = ai;
    this.maintenanceOptions = maintenance;
  }

  /** Time-driven housekeeping settings from `LifeMentorOptions.maintenance` (req. 11, 77, 78). */
  private readonly maintenanceOptions: { enabled?: boolean; intervalMs?: number };

  /** Start periodic sync and reconnect handling. Called automatically when sync is configured. */
  enableSync(engine: SyncEngine, intervalMs = 5 * 60_000): void {
    (this.services as { sync: SyncEngine | null }).sync = engine;
    engine.start(intervalMs);
    if (!this.networkUnsubscribe) {
      this.networkUnsubscribe = this.platform.network.onChange((online) => {
        if (online) void engine.notifyOnline();
      });
    }
  }

  /**
   * Enable cloud sync at runtime — used when the user enters a server URL in settings
   * or signs in for the first time. Idempotent.
   */
  configureSync(options: { serverUrl?: string; transport?: SyncTransport; intervalMs?: number; onEvent?: (event: SyncEvent) => void } = {}): SyncEngine {
    if (this.services.sync && !options.transport && !options.serverUrl) return this.services.sync;
    const transport = options.transport ?? new HttpSyncTransport({
      serverUrl: options.serverUrl ?? '',
      deviceId: this.deviceId,
      getToken: () => this.services.auth.accessToken(),
    });
    if (!options.transport && !options.serverUrl) {
      throw new AppError('validation', 'configureSync needs a serverUrl or a transport', {
        userMessage: 'Enter the LifeMentor server address to enable sync.',
      });
    }
    const engine = new SyncEngine({
      repos: this.repos, transport, settings: this.services.settings, deviceId: this.deviceId, onEvent: options.onEvent,
    });
    this.enableSync(engine, options.intervalMs);
    void this.services.settings.setMany({ sync: { enabled: true, auto_sync: true, server_url: options.serverUrl ?? null } }, { actor: 'user' });
    return engine;
  }

  /** Open (or create) the database and wire every layer. */
  static async create(options: LifeMentorOptions = {}): Promise<LifeMentorApp> {
    if (options.logging?.level) setLogLevel(options.logging.level);
    if (options.logging?.sinks) for (const sink of options.logging.sinks) addGlobalSink(sink);

    const platform = options.platform ?? createDefaultPlatform();
    const detected = await platform.device().catch(() => null);
    const deviceId = options.deviceId ?? detected?.id ?? newId();

    const driver = options.driver ?? await createSqlDriver({
      kind: detectDriverKind(),
      ...options.driverOptions,
    } as CreateDriverOptions);

    const dbOptions: DatabaseOptions = { driver };
    const db = await Database.open(dbOptions);
    const repos = createRepos(db);

    // ── services ──────────────────────────────────────────────────────
    const settings = new SettingsService(repos);
    const personalization = new PersonalizationService(repos);
    const profile = new ProfileService(repos);
    const goals = new GoalService(repos);
    const calendar = new CalendarService(repos);
    const projects = new ProjectService(repos);
    const skills = new SkillService(repos);
    const learning = new LearningService(repos);
    const knowledge = new KnowledgeService(repos);
    const news = new NewsService(repos, settings, profile);
    const notifications = new NotificationService(repos, settings, platform);
    const progress = new ProgressService(repos, personalization, settings);

    // ── AI ────────────────────────────────────────────────────────────
    const aiOptions = options.ai ?? {};
    // A gateway provider only needs the server URL: its token source is wired to the auth layer
    // below, once that exists (req. 20 — the client authenticates, the server holds the keys).
    const gatewayToken: { get: () => Promise<string | null> } = { get: async () => null };
    const providerConfigs: ProviderConfig[] = (aiOptions.providers ?? []).map((config) => (
      config.kind === 'gateway' && config.gateway && !config.gateway.getToken
        ? { ...config, gateway: { ...config.gateway, getToken: () => gatewayToken.get() } }
        : config
    ));
    const provider = aiOptions.provider
      ?? (providerConfigs.length ? createProviderChain(providerConfigs) : new LocalHeuristicProvider());
    const offlineFallback = aiOptions.offlineFallback !== false && !provider.id.startsWith('local');
    const embedder = buildEmbedder(aiOptions.embeddings ?? (provider.capabilities.embeddings ? 'provider' : 'local'), provider);
    const memory = new MemoryService(repos, { embedder: embedder ?? undefined });
    const tasks = new TaskService(repos, personalization, options.taskHooks ?? {});
    const planner = new PlannerService({ repos, calendar, tasks, learning, settings, personalization });

    const tools = createTools({
      tasks, goals, calendar, projects, skills, learning, memory, news, progress,
      notifications, profile, settings, personalization, planner, knowledge, repos,
    });
    const context = new ContextEngine({
      profile, settings, goals, tasks, calendar, projects, skills, learning,
      memory, news, progress, personalization, planner, knowledge,
    });
    const conversations = new ConversationStore(repos, deviceId);
    const orchestrator = new AIOrchestrator({
      provider, tools, context, memory, conversations, settings, deviceId,
      fallback: offlineFallback ? new LocalHeuristicProvider() : provider,
    });

    // Narrative for reviews: deterministic analysis first, model wording second.
    const narrative = narrativeFrom(orchestrator, settings);
    const snapshots = new SnapshotService(repos, progress, settings, narrative);
    const weeklyReviews = new WeeklyReviewService(repos, progress, settings, personalization, narrative);
    const monthlyReviews = new MonthlyReviewService(repos, progress, settings, narrative);
    const strategy = new StrategyService(repos, goals);

    const onboardingAI = createOnboardingAI(orchestrator);
    const onboarding = new OnboardingService({
      repos, settings, profile, goals, skills, knowledge, memory, planner, ai: onboardingAI,
    });

    const mentor = new MentorService({
      orchestrator, tasks, goals, calendar, learning, progress, notifications,
      news, projects, profile, memory, planner, settings, deviceId, weeklyReviews,
    });

    // ── backup / recovery / auth / sync ─────────────────────────────────
    const backupStorage = options.backup?.storage ?? defaultBackupStorage(platform.name, options.backup?.directory);
    const backup = new BackupService({ db, repos, storage: backupStorage, settings, deviceId });

    // The configured server URL is part of the user's settings, not just of the transports:
    // the account row, the sync screen and diagnostics all read it from there.
    const configuredServerUrl = options.sync?.serverUrl ?? options.auth?.serverUrl ?? null;
    if (configuredServerUrl) {
      await settings.setMany({ sync: { server_url: configuredServerUrl } }, { actor: 'system', sync: false });
    }

    const auth = new AuthService({
      repos, secureStorage: platform.secureStorage, settings, deviceId, backup,
      transport: options.auth?.transport,
      transportFactory: async () => {
        const url = options.auth?.serverUrl ?? (await settings.all()).sync.server_url;
        return url ? new HttpAuthTransport({ serverUrl: url }) : null;
      },
    });

    gatewayToken.get = () => auth.accessToken();

    const syncTransport = options.sync?.transport
      ?? (options.sync?.serverUrl
        ? new HttpSyncTransport({
          serverUrl: options.sync.serverUrl,
          deviceId,
          getToken: options.sync.getToken ?? (() => auth.accessToken()),
        })
        : null);

    const sync = syncTransport
      ? new SyncEngine({ repos, transport: syncTransport, settings, deviceId, onEvent: options.sync?.onEvent })
      : null;

    const recovery = new RecoveryService({ db, repos, settings, sync: sync ?? undefined, backup, snapshots, deviceId });

    const app = new LifeMentorApp(db, repos, deviceId, platform, {
      settings, personalization, profile, goals, tasks, calendar, projects, skills, learning,
      memory, knowledge, news, notifications, progress, snapshots, weeklyReviews, monthlyReviews,
      strategy, planner, onboarding, backup, recovery, auth, sync,
    }, {
      provider, tools, context, conversations, orchestrator, mentor,
      embedder, isOffline: provider.id.startsWith('local'),
    }, options.maintenance ?? {});

    if (options.bootstrap !== false) {
      await app.bootstrap(options.deviceName, { recover: options.recover !== false, firstLaunchBackup: options.backup?.onFirstLaunch });
      if (sync && options.sync?.autoStart !== false) app.enableSync(sync, options.sync?.intervalMs);
    }
    return app;
  }

  /**
   * First-launch and every-launch housekeeping: notification preferences,
   * device registration, current-device marker. Idempotent and crash-safe —
   * it only writes what is missing.
   */
  async bootstrap(
    deviceName?: string,
    options: { recover?: boolean; firstLaunchBackup?: boolean } = {},
  ): Promise<{ firstLaunch: boolean; deviceId: string; recovery: RecoveryReport | null }> {
    const firstLaunch = !(await this.repos.devices.exists({}));
    await this.services.notifications.ensureDefaults({ actor: 'system', deviceId: this.deviceId });

    const info = await this.platform.device().catch(() => null);
    const name = deviceName ?? info?.name ?? detectPlatform();
    const existing = await this.repos.devices.byId(this.deviceId);
    if (existing) {
      await this.repos.devices.update(this.deviceId, { last_seen_at: nowIso(), name } as never);
    } else {
      await this.repos.devices.insert({
        id: this.deviceId, name, platform: this.platform.name, is_current: 1,
        registered_at: nowIso(), last_seen_at: nowIso(),
      } as never);
    }
    await this.repos.db.run('UPDATE devices SET is_current = 0 WHERE id <> ?', [this.deviceId]);
    await this.repos.db.run('UPDATE devices SET is_current = 1 WHERE id = ?', [this.deviceId]);

    // Crash recovery runs before the first screen (req. 13).
    if (options.recover !== false) {
      this.recoveryReport = await this.services.recovery.startup();
      if (!this.recoveryReport.ok) log.error('startup recovery reported critical problems', { issues: this.recoveryReport.issues });
    }

    // The baseline protects a database that already holds something (an upgrade that opens an
    // existing file). A brand-new install has nothing to protect: an empty image is junk, and it
    // would also mark the day as "already backed up" and swallow the first real one.
    if (firstLaunch && options.firstLaunchBackup !== false && (await this.hasUserData())) {
      await this.services.backup.createBackup('auto', 'first launch baseline').catch((error) => {
        log.warn('first-launch backup failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }

    // Time-driven work: the end-of-day snapshot and the weekly/monthly reviews must appear on their
    // own (req. 11, 77, 78). This never blocks the first screen and never fails the startup —
    // every step reports its own errors inside the maintenance report.
    if (this.maintenanceOptions.enabled !== false) {
      this.startMaintenance(this.maintenanceOptions.intervalMs ?? MAINTENANCE_INTERVAL_MS);
    }

    log.info('app ready', { deviceId: this.deviceId, firstLaunch, provider: this.ai.provider.id, sync: Boolean(this.services.sync) });
    return { firstLaunch, deviceId: this.deviceId, recovery: this.recoveryReport };
  }

  /** Everything a diagnostics screen needs (req. 96: no silent failures). */
  async health(): Promise<AppHealth> {
    const [integrity, flags, counts] = await Promise.all([
      this.db.integrityCheck(),
      this.services.settings.all(),
      this.counts(),
    ]);
    return {
      ok: integrity.ok,
      deviceId: this.deviceId,
      platform: this.platform.name,
      driver: this.db.driver.kind,
      database: this.db.location,
      schemaVersion: integrity.schemaVersion,
      integrity,
      ai: { provider: this.ai.provider.id, offline: this.ai.isOffline, capabilities: this.ai.provider.capabilities },
      onboarding: { completed: flags.flags.onboarding_completed, modelConfirmed: flags.flags.user_model_confirmed },
      counts,
      checkedAt: nowIso(),
    };
  }

  /** True once the database holds anything the user would mind losing. */
  private async hasUserData(): Promise<boolean> {
    const counts = await this.counts();
    return Object.values(counts).some((n) => n > 0);
  }

  private async counts(): Promise<Record<string, number>> {
    const tables = ['goals', 'tasks', 'calendar_events', 'projects', 'skills', 'learning_paths', 'memories', 'news_items', 'notifications', 'conversations'];
    const out: Record<string, number> = {};
    for (const table of tables) {
      try {
        const rows = await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted = 0`);
        out[table] = Number(rows[0]?.n ?? 0);
      } catch {
        out[table] = -1;
      }
    }
    return out;
  }

  /**
   * Daily maintenance (req. 11, 16, 70, 77, 78, 96) — the one place where time-driven work happens.
   *
   * It runs at every launch and then periodically while the app stays open (`startMaintenance`),
   * so a machine that is never closed at the right moment still gets its end-of-day snapshot and
   * its weekly/monthly review. Every step is guarded by a flag or by an existence check, so calling
   * it a hundred times a day is a no-op after the first — no duplicated reviews, no backup spam.
   *
   * Semantics that matter:
   *  • the snapshot of a day is taken when that day is over (late evening, or on the next launch
   *    for a machine that was switched off) — never as an empty morning stub;
   *  • the weekly review covers the **previous, completed** week, the monthly review the
   *    **previous, completed** month — reviewing the week that just started says nothing;
   *  • days/weeks/months without activity are not recorded at all;
   *  • a failure in any single step is reported, never fatal: the app must still open.
   */
  async dailyMaintenance(now = new Date()): Promise<DailyMaintenanceReport> {
    const day = dayKey(now);
    const flags = await this.services.settings.all();
    const write = { actor: 'system' as const, deviceId: this.deviceId };
    // "When did this device last do X" markers are operational bookkeeping, not user data: sending
    // them through sync would make a second device skip its own evening snapshot and would leave
    // permanent junk in the change feed. Only content (snapshots, reviews) synchronises.
    const flagWrite = { ...write, sync: false as const };
    // Read once, up front: whether there is anything to protect is decided by the state at the
    // start of the pass, not by whatever arrives while the pass is running (a fresh install must
    // not race its own first keystroke into an "automatic backup" of an empty database).
    const hasData = await this.hasUserData();
    const report: DailyMaintenanceReport = {
      day, backfilled: [], snapshot: false, weekly: false, monthly: false, pruned: 0, backup: false, failed: [],
    };

    // 1. Snapshots: fill in days missed while the app was closed (req. 11, 13).
    await this.step(report, 'snapshots.backfill', async () => {
      const result = await this.services.snapshots.ensureUpToDate(write, { now });
      report.backfilled = result.created;
    });

    // 2. End of day: snapshot today once the day is really ending (req. 11).
    if (now.getHours() >= END_OF_DAY_HOUR && flags.flags.last_daily_snapshot_day !== day) {
      await this.step(report, 'snapshot.today', async () => {
        const snapshot = await this.services.snapshots.createIfActive(day, write);
        if (snapshot) {
          await this.services.settings.set('flags', { last_daily_snapshot_day: day }, flagWrite);
          report.snapshot = true;
        }
      });
    }

    // 3. Weekly review of the previous, completed week (req. 77).
    const previousWeek = dayKey(addDays(startOfWeek(now), -7));
    if (flags.flags.last_weekly_review_week !== previousWeek) {
      await this.step(report, 'review.weekly', async () => {
        if (!(await this.services.weeklyReviews.weekHadActivity(previousWeek))) return;
        if (await this.services.weeklyReviews.forWeek(previousWeek)) {
          await this.services.settings.set('flags', { last_weekly_review_week: previousWeek }, flagWrite);
          return;
        }
        await this.services.weeklyReviews.create(previousWeek, write);
        report.weekly = true;
      });
    }

    // 4. Monthly review of the previous, completed month (req. 78).
    // The month before the current one: last day of the previous month, then its first day.
    const previousMonth = dayKey(startOfMonth(addDays(startOfMonth(now), -1))).slice(0, 7);
    if (flags.flags.last_monthly_review_month !== previousMonth) {
      await this.step(report, 'review.monthly', async () => {
        if (!(await this.services.monthlyReviews.monthHadActivity(previousMonth))) return;
        if (await this.services.monthlyReviews.forMonth(previousMonth)) {
          await this.services.settings.set('flags', { last_monthly_review_month: previousMonth }, flagWrite);
          return;
        }
        await this.services.monthlyReviews.create(previousMonth, write);
        report.monthly = true;
      });
    }

    // 5. Retention (req. 70): the user's own setting decides, nothing is deleted behind their back.
    await this.step(report, 'prune', async () => {
      let pruned = 0;
      const retention = flags.privacy.memory_retention_days;
      // Confirmed memories are facts the user owns; they are only dropped by an explicit delete.
      if (retention) pruned += await this.services.memory.prune(retention, { keepConfirmed: true });
      pruned += await this.services.personalization.prune(120);
      pruned += await this.services.news.prune(30);
      pruned += await this.services.notifications.pruneDelivered(30);
      report.pruned = pruned;
    });

    // 6. One backup a day (req. 16), then trim to 7 daily / 4 weekly / 3 monthly. A brand-new
    // install has nothing to protect yet: an empty database image is junk, not a safety net — it
    // appears at the first pass that finds real content.
    if (hasData && this.shouldTakeDailyBackup(flags.flags.last_backup_at, now)) {
      await this.step(report, 'backup', async () => {
        await this.services.backup.createBackup('auto', `daily ${day}`);
        await this.services.backup.rotate();
        report.backup = true;
      });
    }

    await this.step(report, 'checkpoint', async () => { await this.db.checkpoint(); });
    this.lastMaintenanceAt = nowIso();
    this.lastMaintenanceReport = report;
    log.info('daily maintenance finished', { ...report });
    return report;
  }

  private shouldTakeDailyBackup(lastBackupAt: string | null, now: Date): boolean {
    if (!lastBackupAt) return true;
    const last = new Date(lastBackupAt).getTime();
    if (Number.isNaN(last)) return true;
    return now.getTime() - last >= BACKUP_INTERVAL_MS;
  }

  /** Run one maintenance step; a failure is recorded in the report and never breaks the caller. */
  private async step(report: DailyMaintenanceReport, name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ step: name, message });
      log.warn('maintenance step failed', { step: name, error: message });
    }
  }

  /**
   * Keep time-driven work running while the app stays open (a desktop session that lives for days,
   * a phone that is never fully closed). The timer only *checks*: each step inside
   * `dailyMaintenance()` decides for itself whether the day/week/month has turned over.
   */
  startMaintenance(intervalMs = MAINTENANCE_INTERVAL_MS, now = new Date()): void {
    this.stopMaintenance();
    this.maintenanceFirstPass = this.dailyMaintenance(now).catch(() => null);
    const timer = setInterval(() => { void this.dailyMaintenance().catch(() => undefined); }, intervalMs);
    // Never keep a process (or a test runner) alive just for housekeeping.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.maintenanceTimer = timer as unknown as ReturnType<typeof setInterval>;
  }

  /**
   * The first maintenance pass started by bootstrap. The app does not wait for it before showing
   * the first screen (opening must stay fast), but `close()` does, and diagnostics can.
   */
  get maintenanceReady(): Promise<DailyMaintenanceReport | null> { return this.maintenanceFirstPass; }

  stopMaintenance(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  /** When maintenance last ran (diagnostics; null before the first pass). */
  get maintenanceRanAt(): string | null { return this.lastMaintenanceAt; }

  /** Flush everything to durable storage and close the driver. */
  async close(): Promise<void> {
    try {
      this.stopMaintenance();
      // A pass that already started must finish against a live connection, or its work would be
      // half-written; each step is idempotent, so waiting is always safe.
      await this.maintenanceFirstPass.catch(() => undefined);
      this.services.sync?.stop();
      this.networkUnsubscribe?.();
      this.networkUnsubscribe = null;
      await this.db.checkpoint();
    } catch (error) {
      log.warn('checkpoint before close failed', { error: error instanceof Error ? error.message : String(error) });
    }
    await this.db.close();
  }

  /** Convenience for the UI: today's plan + briefing in one call. */
  async today(): Promise<{ day: string; plan: Awaited<ReturnType<PlannerService['buildDay']>>; briefing: Awaited<ReturnType<MentorService['morningBriefing']>> }> {
    const day = dayKey();
    const plan = await this.services.planner.buildDay(day);
    const briefing = await this.ai.mentor.morningBriefing(day, { ai: false });
    return { day, plan, briefing };
  }
}

// ─────────────────────────── wiring helpers ───────────────────────────
function buildEmbedder(mode: 'provider' | 'local' | 'none', provider: AIProvider): Embedder | null {
  if (mode === 'none') return null;
  if (mode === 'local' || !provider.capabilities.embeddings) {
    return { embed: async (texts: string[]) => texts.map((text) => hashEmbed(text)) };
  }
  return {
    embed: async (texts: string[]) => {
      try {
        const vectors = await provider.embed(texts);
        // A provider that returns nothing usable must not break memory writes.
        if (!vectors.length || vectors.some((v) => !v.length)) return texts.map((text) => hashEmbed(text));
        return vectors;
      } catch (error) {
        log.warn('embedding failed, falling back to local hashing', { error: error instanceof Error ? error.message : String(error) });
        return texts.map((text) => hashEmbed(text));
      }
    },
  };
}

function narrativeFrom(orchestrator: AIOrchestrator, settings: SettingsService): NarrativeGenerator {
  return async ({ kind, data }) => {
    const all = await settings.all();
    const intent = kind === 'daily' ? 'summarize_day' : kind === 'weekly' ? 'summarize_week' : 'summarize_month';
    const result = await orchestrator.structured(intent, `Summarise this ${kind} review for the user in ${all.ai.language}. Use only the numbers provided. No praise inflation, no invented facts.`, z.object({ summary: z.string().min(1).max(800) }), { tier: 'mid', extra: data, maxTokens: 400 });
    // The built-in offline engine answers with a generic template that cannot tell which period it
    // is describing (it produced "Today: 0 tasks done" for a snapshot of yesterday). A wrong
    // sentence is worse than no sentence: fall through to the service's own text, which is built
    // from the real numbers of the real day/week/month. A real model words it better — and only
    // then do we use its wording.
    if (result.offline) return null;
    return result.data.summary || null;
  };
}

/**
 * Adapter: the orchestrator as the optional onboarding AI. Onboarding keeps its
 * deterministic detectors; these calls only add proposals on top and every one of
 * them is allowed to fail.
 */
export function createOnboardingAI(orchestrator: AIOrchestrator): OnboardingAI {
  const GapProposalSchema = z.object({
    gaps: z.array(z.object({
      gap_type: z.enum(['missing_data', 'contradiction', 'vague_goal', 'goal_conflict', 'skill_ambiguity', 'unknown_constraint', 'missing_horizon']),
      target: z.string().min(1).max(60),
      question: z.string().min(4).max(300),
      rationale: z.string().min(4).max(300),
      importance: z.number().min(0).max(1).default(0.6),
      options: z.array(z.object({ id: z.string().max(40), label: z.string().max(120) })).max(6).default([]),
    })).max(8).default([]),
  });

  const GoalProposalSchema = z.object({
    goals: z.array(z.object({
      title: z.string().min(3).max(200),
      description: z.string().max(1000).optional(),
      horizon: z.enum(['long', 'medium', 'short', 'daily']),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']),
      area: z.string().max(80).optional(),
      motivation: z.string().max(500).optional(),
      target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })).max(6).default([]),
  });

  return {
    async proposeQuestions(model: { answers: AnswersMap; gaps: GapCandidate[] }): Promise<GapCandidate[]> {
      const result = await orchestrator.structured(
        'interview_questions',
        'You are interviewing a new user to build their model. Based on the answers and the gaps already detected, propose additional questions that would most improve the model. Never ask about something already answered. Each question needs a one-line rationale the user can see.',
        GapProposalSchema,
        { tier: 'mid', extra: { answers: model.answers, detected_gaps: model.gaps }, maxTokens: 900 },
      );
      return (result.data.gaps ?? []).map((gap) => ({
        gap_type: gap.gap_type, target: gap.target, question: gap.question, rationale: gap.rationale,
        importance: gap.importance ?? 0.6, options: gap.options?.length ? gap.options : undefined,
      }));
    },

    async proposeGoals(answers: AnswersMap, gaps: GapCandidate[]): Promise<GoalDraft[]> {
      const result = await orchestrator.structured(
        'extract_goals',
        'Propose the first goals for this user based ONLY on what they stated. Do not invent ambitions, do not promise income, keep them concrete and sized to their available time.',
        GoalProposalSchema,
        { tier: 'mid', extra: { answers, gaps }, maxTokens: 900 },
      );
      return (result.data.goals ?? []).map((goal) => ({
        title: goal.title, description: goal.description ?? null, horizon: goal.horizon, priority: goal.priority,
        area: goal.area ?? null, motivation: goal.motivation ?? null, target_date: goal.target_date ?? null,
      }));
    },

    async summariseModel(model: { items: unknown[]; assumptions: unknown[]; unknowns: string[] }): Promise<string | null> {
      const result = await orchestrator.structured(
        'memory_review',
        'Write a short summary (max 5 sentences) of this user model for the confirmation screen. State clearly which parts are assumptions that need checking. Never present an assumption as a fact.',
        z.object({ summary: z.string().min(10).max(900) }),
        { tier: 'mid', extra: model, maxTokens: 500 },
      );
      // Same rule as the review narratives: the offline engine cannot tell a user model from a day
      // summary — it answered "Today: 0 tasks done, 0m focus…" for this call, in English, on the
      // screen where the user confirms who they are. A wrong sentence is worse than none.
      if (result.offline) return null;
      return result.data.summary;
    },
  };
}

/** Backups live on the filesystem on desktop/server and in OPFS/IndexedDB in a browser. */
function defaultBackupStorage(platform: string, directory?: string): BackupStorage {
  if (platform === 'web') return new WebBackupStorage();
  return new NodeBackupStorage({ directory: directory ?? 'backups' });
}

function weekStartOf(date: Date): string {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday-first
  copy.setDate(copy.getDate() + diff);
  return dayKey(copy);
}

export type { SqlDriver, PlatformAdapter, Repos, Database };
