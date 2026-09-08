import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';

/**
 * Typed application settings. Stored as one versioned+synced row per group in `settings`,
 * so a change on the phone reaches the desktop (req. 59) and survives a crash (req. 8).
 */

export const PlanningSettings = z.object({
  /** strict = the mentor challenges skips; balanced = default; flexible = suggestions only */
  style: z.enum(['strict', 'balanced', 'flexible']).default('balanced'),
  strictness: z.number().min(0).max(1).default(0.6),
  /** protected free time per day, excluding commute/meals/chores (req. 34) */
  free_time_minutes: z.number().int().min(0).max(480).default(90),
  buffer_minutes: z.number().int().min(0).max(60).default(10),
  work_start: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  work_end: z.string().regex(/^\d{2}:\d{2}$/).default('21:00'),
  wake_time: z.string().regex(/^\d{2}:\d{2}$/).default('07:30'),
  sleep_time: z.string().regex(/^\d{2}:\d{2}$/).default('23:30'),
  max_focus_hours_per_day: z.number().min(0.5).max(12).default(5),
  break_every_minutes: z.number().int().min(20).max(180).default(90),
  reminder_style: z.enum(['none', 'gentle', 'firm']).default('gentle'),
});

export const NotificationSettings = z.object({
  enabled: z.boolean().default(true),
  quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().default('22:30'),
  quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().default('07:30'),
  /** req. 86 — the AI may not write twenty times a day */
  daily_budget: z.number().int().min(0).max(30).default(6),
  proactive_mentor: z.boolean().default(true),
  channels: z.array(z.enum(['local', 'push', 'in_app'])).default(['local', 'in_app']),
  digest_time: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
});

export const AISettings = z.object({
  memory_enabled: z.boolean().default(true),
  /** 'auto' picks the configured server provider, 'local' forces the offline heuristic engine */
  provider_preference: z.enum(['auto', 'local']).default('auto'),
  context_budget_tokens: z.number().int().min(1000).max(32000).default(6000),
  confirm_fact_changes: z.boolean().default(true),
  language: z.string().default('en'),
});

export const SyncSettings = z.object({
  enabled: z.boolean().default(true),
  auto_sync: z.boolean().default(true),
  server_url: z.string().nullable().default(null),
  sync_wifi_only: z.boolean().default(false),
});

export const PrivacySettings = z.object({
  telemetry: z.boolean().default(false),
  cloud_backup: z.boolean().default(false),
  analytics: z.boolean().default(true),
  memory_retention_days: z.number().int().min(30).max(3650).nullable().default(null),
});

export const LearningSettings = z.object({
  daily_minutes: z.number().int().min(0).max(600).default(60),
  review_limit: z.number().int().min(1).max(200).default(20),
  preferred_formats: z.array(z.string()).default([]),
  session_length_minutes: z.number().int().min(10).max(180).default(45),
});

export const NewsSettings = z.object({
  enabled: z.boolean().default(true),
  categories: z.array(z.string()).default(['world', 'technology', 'ai', 'economy', 'science']),
  urgent_push: z.boolean().default(true),
  digest_enabled: z.boolean().default(true),
});

export const ProfileSettings = z.object({
  display_name: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
  locale: z.string().default('en'),
  week_starts_on: z.enum(['monday', 'sunday']).default('monday'),
});

export const FlagSettings = z.object({
  onboarding_completed: z.boolean().default(false),
  user_model_confirmed: z.boolean().default(false),
  first_plan_generated: z.boolean().default(false),
  last_daily_snapshot_day: z.string().nullable().default(null),
  last_weekly_review_week: z.string().nullable().default(null),
  last_monthly_review_month: z.string().nullable().default(null),
  last_backup_at: z.string().nullable().default(null),
});

export const SETTINGS_GROUPS = {
  profile: ProfileSettings,
  planning: PlanningSettings,
  notifications: NotificationSettings,
  ai: AISettings,
  sync: SyncSettings,
  privacy: PrivacySettings,
  learning: LearningSettings,
  news: NewsSettings,
  flags: FlagSettings,
} as const;

export type SettingsGroup = keyof typeof SETTINGS_GROUPS;
export type SettingsMap = { [K in SettingsGroup]: z.infer<(typeof SETTINGS_GROUPS)[K]> };

const CATEGORY: Record<SettingsGroup, string> = {
  profile: 'general', planning: 'planning', notifications: 'notifications', ai: 'ai',
  sync: 'sync', privacy: 'privacy', learning: 'learning', news: 'news', flags: 'system',
};

export class SettingsService {
  private cache: Record<string, unknown> = {};

  constructor(private readonly repos: Repos) {}

  /** Full settings object with defaults applied (never throws on partial/corrupt rows). */
  async all(): Promise<SettingsMap> {
    const out = {} as SettingsMap;
    for (const group of Object.keys(SETTINGS_GROUPS) as SettingsGroup[]) (out as Record<string, unknown>)[group] = await this.get(group);
    return out;
  }

  async get<G extends SettingsGroup>(group: G): Promise<SettingsMap[G]> {
    const cached = this.cache[group];
    if (cached) return cached as SettingsMap[G];
    const schema = SETTINGS_GROUPS[group];
    const row = await this.repos.settings.byId(group);
    let parsed: unknown = {};
    if (row?.value) {
      try { parsed = JSON.parse(row.value); } catch { parsed = {}; }
    }
    const result = schema.safeParse(parsed);
    // A corrupt or partial row falls back to defaults instead of breaking the app.
    const value = (result.success ? result.data : schema.parse({})) as SettingsMap[G];
    this.cache[group] = value;
    return value;
  }

  async set<G extends SettingsGroup>(group: G, patch: Partial<SettingsMap[G]>, ctx: WriteContext = USER_WRITE): Promise<SettingsMap[G]> {
    const schema = SETTINGS_GROUPS[group];
    const current = await this.get(group);
    const candidate = { ...current, ...patch };
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw AppError.validation(`Invalid ${group} settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const row = await this.repos.settings.byId(group);
    const value = JSON.stringify(parsed.data);
    if (!row) {
      await this.repos.settings.insert({ key: group, value, category: CATEGORY[group], scope: 'synced' } as never, ctx);
    } else if (row.value !== value) {
      await this.repos.settings.update(group, { value, category: CATEGORY[group] } as never, { ...ctx, reason: `settings.${group}` });
    }
    this.cache[group] = parsed.data;
    return parsed.data as SettingsMap[G];
  }

  /** Transactional multi-group update (used by onboarding "apply answers as preferences"). */
  async setMany(values: Partial<{ [K in SettingsGroup]: Partial<SettingsMap[K]> }>, ctx: WriteContext = USER_WRITE): Promise<void> {
    for (const [group, patch] of Object.entries(values)) {
      await this.set(group as SettingsGroup, patch as never, ctx);
    }
  }

  invalidate(): void { this.cache = {}; }

  // ───────────────── local UI state (drafts, last route) — crash-safe restore, not synced ─────────────────
  async getState<T>(key: string): Promise<T | null> {
    const row = await this.repos.appState.byId(key);
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  async setState(key: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value ?? null);
    const row = await this.repos.appState.byId(key);
    if (!row) await this.repos.appState.insert({ key, value: encoded, updated_at: nowIso() } as never);
    else await this.repos.appState.update(key, { value: encoded, updated_at: nowIso() } as never);
  }

  async clearState(key: string): Promise<void> {
    await this.repos.appState.hardDelete(key);
  }
}
