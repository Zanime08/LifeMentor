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
import { dayKey, nowIso } from './util/time';
const log = createLogger('app');

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
  /** Run the first-launch bootstrap (defaults, device registration). Default true. */
  bootstrap?: boolean;
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

  private constructor(
    db: Database,
    repos: Repos,
    deviceId: string,
    platform: PlatformAdapter,
    services: AppServices,
    ai: AppAI,
  ) {
    this.db = db;
    this.repos = repos;
    this.deviceId = deviceId;
    this.platform = platform;
    this.logger = log;
    this.services = services;
    this.ai = ai;
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
    const provider = aiOptions.provider
      ?? (aiOptions.providers?.length ? createProviderChain(aiOptions.providers) : new LocalHeuristicProvider());
    const offlineFallback = aiOptions.offlineFallback !== false && !provider.id.startsWith('local');
    const embedder = buildEmbedder(aiOptions.embeddings ?? (provider.capabilities.embeddings ? 'provider' : 'local'), provider);
    const memory = new MemoryService(repos, { embedder: embedder ?? undefined });
    const tasks = new TaskService(repos, personalization, options.taskHooks ?? {});
    const planner = new PlannerService({ repos, calendar, tasks, learning, settings, personalization });

    const tools = createTools({
      tasks, goals, calendar, projects, skills, learning, memory, news, progress,
      notifications, profile, settings, personalization, planner, knowledge,
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
      news, projects, profile, memory, planner, settings, deviceId,
    });

    const app = new LifeMentorApp(db, repos, deviceId, platform, {
      settings, personalization, profile, goals, tasks, calendar, projects, skills, learning,
      memory, knowledge, news, notifications, progress, snapshots, weeklyReviews, monthlyReviews,
      strategy, planner, onboarding,
    }, {
      provider, tools, context, conversations, orchestrator, mentor,
      embedder, isOffline: provider.id.startsWith('local'),
    });

    if (options.bootstrap !== false) await app.bootstrap(options.deviceName);
    return app;
  }

  /**
   * First-launch and every-launch housekeeping: notification preferences,
   * device registration, current-device marker. Idempotent and crash-safe —
   * it only writes what is missing.
   */
  async bootstrap(deviceName?: string): Promise<{ firstLaunch: boolean; deviceId: string }> {
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

    log.info('app ready', { deviceId: this.deviceId, firstLaunch, provider: this.ai.provider.id });
    return { firstLaunch, deviceId: this.deviceId };
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

  /** End-of-day housekeeping: snapshot, reviews when due, memory pruning, WAL checkpoint. */
  async dailyMaintenance(now = new Date()): Promise<{ snapshot: boolean; weekly: boolean; monthly: boolean; pruned: number }> {
    const day = dayKey(now);
    const flags = await this.services.settings.all();
    const write = { actor: 'system' as const, deviceId: this.deviceId };

    let snapshot = false;
    if (flags.flags.last_daily_snapshot_day !== day) {
      await this.services.snapshots.create(day, write);
      await this.services.settings.setState('last_daily_snapshot_day', day);
      snapshot = true;
    }

    let weekly = false;
    const weekStart = weekStartOf(now);
    if (flags.flags.last_weekly_review_week !== weekStart) {
      await this.services.weeklyReviews.create(weekStart, write);
      await this.services.settings.setState('last_weekly_review_week', weekStart);
      weekly = true;
    }

    let monthly = false;
    const month = day.slice(0, 7);
    if (flags.flags.last_monthly_review_month !== month) {
      await this.services.monthlyReviews.create(month, write);
      await this.services.settings.setState('last_monthly_review_month', month);
      monthly = true;
    }

    let pruned = 0;
    const retention = flags.privacy.memory_retention_days;
    if (retention) pruned += await this.services.memory.prune(retention, { keepConfirmed: true });
    pruned += await this.services.personalization.prune(120);
    pruned += await this.services.news.prune(30);
    pruned += await this.services.notifications.pruneDelivered(30);

    await this.db.checkpoint();
    return { snapshot, weekly, monthly, pruned };
  }

  /** Flush everything to durable storage and close the driver. */
  async close(): Promise<void> {
    try {
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

function narrativeFrom(orchestrator: AIOrchestrator, settings: SettingsService) {
  return async ({ kind, data }: { kind: 'daily' | 'weekly' | 'monthly'; data: Record<string, unknown> }): Promise<string> => {
    const all = await settings.all();
    const intent = kind === 'daily' ? 'summarize_day' : kind === 'weekly' ? 'summarize_week' : 'summarize_month';
    const result = await orchestrator.structured(intent, `Summarise this ${kind} review for the user in ${all.ai.language}. Use only the numbers provided. No praise inflation, no invented facts.`, z.object({ summary: z.string().min(1).max(800) }), { tier: 'mid', extra: data, maxTokens: 400 });
    return result.data.summary;
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

    async summariseModel(model: { items: unknown[]; assumptions: unknown[]; unknowns: string[] }): Promise<string> {
      const result = await orchestrator.structured(
        'summarize_day',
        'Write a short summary (max 5 sentences) of this user model for the confirmation screen. State clearly which parts are assumptions that need checking. Never present an assumption as a fact.',
        z.object({ summary: z.string().min(10).max(900) }),
        { tier: 'mid', extra: model, maxTokens: 500 },
      );
      return result.data.summary;
    },
  };
}

function weekStartOf(date: Date): string {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday-first
  copy.setDate(copy.getDate() + diff);
  return dayKey(copy);
}

export type { SqlDriver, PlatformAdapter, Repos, Database };
