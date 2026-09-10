import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { DayPlan, Notification, NotificationType } from '../domain/types';
import { NOTIFICATION_TYPES } from '../domain/types';
import type { SettingsService } from './settings';
import type { PlatformAdapter, ScheduledNotification } from '../platform/adapter';
import { newId } from '../util/id';
import { addMinutes, dateFromDayKey, dayKey, minutesToTime, nowIso, timeToMinutes } from '../util/time';
import { createLogger } from '../util/logging';
import { isRussian, planDuration, planNoteText, planNotesText, pluralRu } from '../planning/plan-text';

export const CreateNotificationSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1000),
  importance: z.number().min(0).max(1).default(0.5),
  scheduled_at: z.string().nullish(),
  channel: z.enum(['local', 'push', 'in_app']).default('local'),
  action_type: z.string().max(40).nullish(),
  entity_type: z.string().max(40).nullish(),
  entity_id: z.string().max(80).nullish(),
  context: z.record(z.unknown()).nullish(),
  dedupe_key: z.string().max(160).nullish(),
  /** Bypass the daily budget (used only for genuinely urgent items). */
  force: z.boolean().default(false),
});
export type CreateNotificationInput = z.input<typeof CreateNotificationSchema>;

export type GateDecision =
  | { delivered: true; notification: Notification; adjusted?: string }
  | { delivered: false; reason: 'disabled' | 'type_disabled' | 'budget_exhausted' | 'duplicate' | 'invalid' };

const DEDUPE_WINDOW_HOURS = 3;
const URGENT_IMPORTANCE = 0.85;

/**
 * Notifications (req. 49, 50, 86, 87).
 *
 * Every notification passes a gate: enabled? quiet hours? duplicate? daily budget?
 * Nothing is sent "just because we can", and each body must carry context
 * ("In 10 minutes Python starts. Today's task: finish the auth function.").
 */
export class NotificationService {
  private readonly log = createLogger('notification');

  constructor(
    private readonly repos: Repos,
    private readonly settings: SettingsService,
    private readonly platform?: PlatformAdapter,
  ) {}

  async create(input: CreateNotificationInput, ctx: WriteContext = USER_WRITE): Promise<GateDecision> {
    const parsed = CreateNotificationSchema.parse(input);
    const prefs = await this.preferences();
    const global = await this.settings.get('notifications');

    if (!global.enabled) return { delivered: false, reason: 'disabled' };
    // A row for a concrete type means the user customized that type; without one, the global settings
    // are the source of truth. Quiet hours and the daily budget used to come from rows created on the
    // first launch, which froze those values and silently ignored every later change in Settings.
    const typePref = prefs[parsed.type] ?? prefs['*'];
    if (typePref && typePref.enabled === 0) return { delivered: false, reason: 'type_disabled' };

    let scheduledAt = parsed.scheduled_at ? new Date(parsed.scheduled_at) : new Date();
    let adjusted: string | undefined;
    const quiet = this.quietWindow(typePref?.quiet_start ?? global.quiet_start, typePref?.quiet_end ?? global.quiet_end);
    if (quiet && this.isQuietAt(scheduledAt, quiet) && parsed.importance < URGENT_IMPORTANCE) {
      scheduledAt = this.nextAfterQuiet(scheduledAt, quiet);
      adjusted = `moved out of quiet hours to ${scheduledAt.toISOString()}`;
    }
    if (scheduledAt.getTime() < Date.now() - 60_000 && parsed.scheduled_at) {
      // A stale schedule time is delivered now rather than being silently dropped.
      scheduledAt = new Date();
      adjusted = 'scheduled time already passed — delivering now';
    }

    const budgetDay = dayKey(scheduledAt);
    const dedupeKey = parsed.dedupe_key ?? `${parsed.type}:${parsed.entity_type ?? ''}:${parsed.entity_id ?? ''}`;

    if (!parsed.force) {
      const duplicate = await this.repos.notifications.findOne({
        dedupe_key: dedupeKey,
        cancelled_at: null,
        created_at: { op: 'gte', value: addMinutes(new Date(), -DEDUPE_WINDOW_HOURS * 60).toISOString() },
      });
      if (duplicate) return { delivered: false, reason: 'duplicate' };

      const budget = typePref?.daily_budget ?? global.daily_budget;
      const used = await this.budgetUsed(budgetDay);
      if (used >= budget && parsed.importance < URGENT_IMPORTANCE) {
        this.log.info('notification skipped: daily budget exhausted', { type: parsed.type, budgetDay, used, budget });
        return { delivered: false, reason: 'budget_exhausted' };
      }
    }

    const notification = await this.repos.notifications.insert({
      id: newId(),
      type: parsed.type,
      title: parsed.title,
      body: parsed.body,
      context_json: parsed.context ? JSON.stringify(parsed.context) : null,
      importance: parsed.importance,
      channel: parsed.channel,
      scheduled_at: scheduledAt.toISOString(),
      delivered_at: null,
      read_at: null,
      cancelled_at: null,
      action_type: parsed.action_type ?? defaultAction(parsed.type),
      entity_type: parsed.entity_type ?? null,
      entity_id: parsed.entity_id ?? null,
      budget_day: budgetDay,
      dedupe_key: dedupeKey,
    } as never, { ...ctx, reason: `notification ${parsed.type}` });

    await this.pushToDevice([notification]);
    return { delivered: true, notification, adjusted };
  }

  /** Turn a day plan into contextual reminders (req. 87). */
  async scheduleFromPlan(plan: DayPlan, options: { leadMinutes?: number } = {}, ctx: WriteContext = USER_WRITE): Promise<Notification[]> {
    const lead = options.leadMinutes ?? 10;
    const created: Notification[] = [];
    const dayStart = dateFromDayKey(plan.day);
    const lang = await this.language();
    const ru = isRussian(lang);
    const blocks = plan.slots.filter((s) => s.kind === 'task').length;

    if (plan.slots.length) {
      const first = plan.slots[0];
      const decision = await this.create({
        type: 'daily_plan',
        title: ru
          ? `Сегодня: ${blocks} ${pluralRu(blocks, 'блок работы', 'блока работы', 'блоков работы')}, ${planDuration(plan.focus_minutes, lang)}`
          : `Today: ${blocks} focus block(s), ${Math.round(plan.focus_minutes / 60 * 10) / 10}h`,
        body: this.planSummary(plan, lang),
        importance: 0.6,
        scheduled_at: new Date(dayStart.getTime() + timeToMinutes(first.start) * 60_000 - lead * 60_000).toISOString(),
        context: { day: plan.day, deferred: plan.deferred.length, warnings: plan.warnings },
        dedupe_key: `daily_plan:${plan.day}`,
      }, ctx);
      if (decision.delivered) created.push(decision.notification);
    }

    for (const slot of plan.slots) {
      if (slot.kind !== 'task' && slot.kind !== 'event') continue;
      const at = new Date(dayStart.getTime() + timeToMinutes(slot.start) * 60_000 - lead * 60_000);
      if (at.getTime() < Date.now()) continue;
      // The title of a generated block («Spaced repetition (3 cards due)») is the engine's words,
      // not the user's — word it for the reader; task and event titles are the user's own.
      const generated = slot.generated_title ? planNoteText(slot.generated_title, lang) : null;
      const title = `${slot.start} — ${generated ?? slot.title}`;
      const why = planNotesText(slot.note_items, lang) ?? slot.note;
      const decision = await this.create({
        type: slot.kind === 'event' ? 'schedule_start' : 'task_reminder',
        title,
        body: slot.kind === 'event'
          ? (ru
            ? `Начинается в ${slot.start}${slot.immovable ? ' (жёсткое обязательство)' : ''}.`
            : `Starts at ${slot.start}${slot.immovable ? ' (fixed commitment)' : ''}.`)
          : (ru
            ? `Начинается в ${slot.start}, ~${minutesBetweenTime(slot.start, slot.end)} мин.${why ? ` Почему сейчас: ${why}.` : ''}`
            : `Starts at ${slot.start}, ~${minutesBetweenTime(slot.start, slot.end)} minutes.${why ? ` Why this now: ${why}.` : ''}`),
        importance: slot.priority === 'P0' ? 0.8 : slot.immovable ? 0.75 : 0.5,
        scheduled_at: at.toISOString(),
        entity_type: slot.kind === 'event' ? 'calendar_event' : 'task',
        entity_id: slot.eventId ?? slot.taskId ?? null,
        action_type: slot.kind === 'event' ? 'open_event' : 'open_task',
        dedupe_key: `${slot.kind}:${slot.eventId ?? slot.taskId}:${plan.day}`,
      }, ctx);
      if (decision.delivered) created.push(decision.notification);
    }
    return created;
  }

  /** The body of the morning reminder: the same facts, in the language the user reads. */
  private planSummary(plan: DayPlan, language = 'en'): string {
    const ru = isRussian(language);
    const tasks = plan.slots.filter((s) => s.kind === 'task');
    const first = tasks[0];
    const title = (slot: (typeof tasks)[number]): string =>
      (slot.generated_title ? planNoteText(slot.generated_title, language) : null) ?? slot.title;
    const parts: string[] = [];
    if (first) parts.push(ru ? `Первое: ${first.start} ${title(first)}.` : `First: ${first.start} ${title(first)}.`);
    parts.push(ru
      ? `${planDuration(plan.focus_minutes, language)} фокуса, ${planDuration(plan.free_minutes, language)} защищённого свободного времени.`
      : `${Math.round(plan.focus_minutes / 60 * 10) / 10}h focus, ${Math.round(plan.free_minutes / 60 * 10) / 10}h protected free time.`);
    if (plan.deferred.length) {
      // Agreement matters: «1 пункт не вошёл», «2 пункта не вошли», «5 пунктов не вошли».
      parts.push(ru
        ? `${plan.deferred.length} ${pluralRu(plan.deferred.length, 'пункт', 'пункта', 'пунктов')} `
          + `${plan.deferred.length === 1 ? 'не вошёл' : 'не вошли'} в день.`
        : `${plan.deferred.length} item(s) did not fit today.`);
    }
    // A plan built by an older build has English warnings only; showing one is better than hiding
    // that the day is overloaded, and the next plan build replaces it with the structured form.
    const warning = plan.warning_items?.length ? plan.warning_items.map((w) => planNoteText(w, language)).find(Boolean) : null;
    if (warning) parts.push(warning!);
    else if (plan.warnings[0]) parts.push(plan.warnings[0]);
    return parts.join(' ');
  }

  async pending(now = new Date(), limit = 50): Promise<Notification[]> {
    return this.repos.notifications.find(
      { delivered_at: null, cancelled_at: null, scheduled_at: { op: 'lte', value: now.toISOString() } },
      { orderBy: { scheduled_at: 'asc' }, limit },
    );
  }

  async upcoming(limit = 50, now = new Date()): Promise<Notification[]> {
    return this.repos.notifications.find(
      { delivered_at: null, cancelled_at: null, scheduled_at: { op: 'gt', value: now.toISOString() } },
      { orderBy: { scheduled_at: 'asc' }, limit },
    );
  }

  async inbox(limit = 50): Promise<Notification[]> {
    return this.repos.notifications.find({ cancelled_at: null }, { orderBy: { scheduled_at: 'desc' }, limit });
  }

  async markDelivered(id: string, at = nowIso(), ctx: WriteContext = { actor: 'system' }): Promise<void> {
    await this.repos.notifications.update(id, { delivered_at: at } as never, { ...ctx, audit: false });
  }

  async markRead(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.notifications.update(id, { read_at: nowIso() } as never, { ...ctx, audit: false });
  }

  async cancel(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.notifications.update(id, { cancelled_at: nowIso() } as never, { ...ctx, reason: 'notification cancelled' });
    await this.platform?.notifications.cancel([id]).catch(() => undefined);
  }

  async cancelFor(entityType: string, entityId: string, ctx: WriteContext = USER_WRITE): Promise<number> {
    const rows = await this.repos.notifications.find({ entity_type: entityType, entity_id: entityId, delivered_at: null, cancelled_at: null }, { limit: 200 });
    for (const row of rows) await this.cancel(row.id, ctx);
    return rows.length;
  }

  /** Hand pending notifications to the OS scheduler (works offline; shells re-run on boot). */
  async pushToDevice(notifications?: Notification[]): Promise<void> {
    if (!this.platform) return;
    const items = notifications ?? [...await this.pending(), ...await this.upcoming()];
    if (!items.length) return;
    const payload: ScheduledNotification[] = items
      .filter((n) => n.cancelled_at === null && n.delivered_at === null && n.scheduled_at >= new Date(Date.now() - 60_000).toISOString())
      .map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        at: n.scheduled_at,
        data: { type: n.type, entity_type: n.entity_type, entity_id: n.entity_id, action: n.action_type },
      }));
    if (!payload.length) return;
    try {
      const permission = await this.platform.notifications.requestPermission();
      if (permission !== 'granted') return;
      await this.platform.notifications.schedule(payload);
    } catch (error) {
      this.log.warn('could not schedule device notifications', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async budgetUsed(day: string): Promise<number> {
    return this.repos.notifications.count({ budget_day: day, cancelled_at: null });
  }

  async budgetStatus(day = dayKey()): Promise<{ day: string; used: number; limit: number; remaining: number }> {
    const global = await this.settings.get('notifications');
    const used = await this.budgetUsed(day);
    return { day, used, limit: global.daily_budget, remaining: Math.max(0, global.daily_budget - used) };
  }

  async preferences(): Promise<Record<string, { enabled: 0 | 1; channels: string[]; quiet_start: string | null; quiet_end: string | null; daily_budget: number }>> {
    const rows = await this.repos.notificationPreferences.find({}, { limit: 50 });
    const out: Record<string, { enabled: 0 | 1; channels: string[]; quiet_start: string | null; quiet_end: string | null; daily_budget: number }> = {};
    for (const row of rows) {
      out[row.type] = {
        enabled: row.enabled,
        channels: safeParse<string[]>(row.channels, ['local', 'in_app']),
        quiet_start: row.quiet_start,
        quiet_end: row.quiet_end,
        daily_budget: Number(row.daily_budget ?? 6),
      };
    }
    return out;
  }

  /**
   * Write a per-type (or global `'*'`) preference. The row is the *override*: values left out keep
   * falling back to the settings the user edits in «Настройки → Уведомления».
   */
  async setPreference(type: NotificationType | '*', patch: { enabled?: boolean; channels?: string[]; quiet_start?: string | null; quiet_end?: string | null; daily_budget?: number }, ctx: WriteContext = USER_WRITE): Promise<void> {
    const record: Record<string, unknown> = {};
    if (patch.enabled !== undefined) record.enabled = patch.enabled ? 1 : 0;
    if (patch.channels !== undefined) record.channels = JSON.stringify(patch.channels);
    if (patch.quiet_start !== undefined) record.quiet_start = patch.quiet_start;
    if (patch.quiet_end !== undefined) record.quiet_end = patch.quiet_end;
    if (patch.daily_budget !== undefined) record.daily_budget = Math.max(0, Math.min(30, Math.round(patch.daily_budget)));
    const existing = await this.repos.notificationPreferences.byId(type);
    if (!existing) {
      await this.repos.notificationPreferences.insert({
        type, enabled: patch.enabled === false ? 0 : 1, channels: JSON.stringify(patch.channels ?? ['local', 'in_app']),
        quiet_start: patch.quiet_start ?? null, quiet_end: patch.quiet_end ?? null, daily_budget: patch.daily_budget ?? 6,
      } as never, ctx);
    } else {
      await this.repos.notificationPreferences.update(type, record as never, { ...ctx, reason: `notification preference ${type}` });
    }
    if (type === '*' && patch.daily_budget !== undefined) await this.settings.set('notifications', { daily_budget: patch.daily_budget }, ctx);
  }

  /**
   * Bring the per-type preference rows into a sane state (called on every launch).
   *
   * It used to *create* a row per notification type, copying the global settings of the moment. Those
   * rows then shadowed the globals for the rest of the installation's life: a user who moved quiet
   * hours to 01:00–02:00 in Settings still had every notification pushed out of 22:30–07:30, because
   * that is what the first launch had written. Nothing has ever called `setPreference` (the interface
   * has no per-type controls), so those rows only carried defaults — they are removed once, and from
   * then on a row means what the table comment says it means: "this type is customized".
   */
  async ensureDefaults(ctx: WriteContext = { actor: 'system' }): Promise<void> {
    const flags = await this.settings.get('flags');
    if (flags.notification_preferences_reconciled) return;
    const existing = await this.repos.notificationPreferences.find({}, { limit: 50 });
    for (const row of existing) {
      await this.repos.notificationPreferences.softDelete(row.type, { ...ctx, reason: 'per-type defaults removed: the global settings are the source of truth' });
    }
    // The flag is per device bookkeeping: syncing it would make each launch look like a user edit to
    // the other devices (and a same-key settings row from two devices is a needless conflict).
    await this.settings.set('flags', { notification_preferences_reconciled: true }, { ...ctx, sync: false });
    if (existing.length) this.log.info('removed per-type notification defaults frozen at first launch', { rows: existing.length });
  }

  /** Silencing one kind of notification without touching the others. */
  async setTypeEnabled(type: NotificationType, enabled: boolean, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.setPreference(type, { enabled }, ctx);
  }

  /**
   * The language the user reads in — the same rule as onboarding and the mentor. Notification text is
   * the one kind the engine must compose itself: the OS scheduler and the push sender deliver it with
   * no interface running, so there is no screen to word a code.
   */
  private async language(): Promise<string> {
    try {
      const all = await this.settings.all();
      return all.ai.language || all.profile.locale || 'en';
    } catch {
      return 'en';
    }
  }

  isQuietAt(at: Date, quiet: { start: number; end: number }): boolean {
    const minutes = at.getHours() * 60 + at.getMinutes();
    return quiet.start <= quiet.end
      ? minutes >= quiet.start && minutes < quiet.end
      : minutes >= quiet.start || minutes < quiet.end; // wraps midnight
  }

  private quietWindow(start: string | null, end: string | null): { start: number; end: number } | null {
    if (!start || !end) return null;
    return { start: timeToMinutes(start), end: timeToMinutes(end) };
  }

  private nextAfterQuiet(at: Date, quiet: { start: number; end: number }): Date {
    const base = dateFromDayKey(dayKey(at));
    let candidate = new Date(base.getTime() + quiet.end * 60_000);
    if (candidate.getTime() <= at.getTime()) candidate = addMinutes(candidate, 24 * 60);
    return candidate;
  }

  async pruneDelivered(days = 30): Promise<number> {
    const cutoff = addMinutes(new Date(), -days * 24 * 60).toISOString();
    const res = await this.repos.db.run(
      `DELETE FROM notifications WHERE delivered_at IS NOT NULL AND delivered_at < ?`,
      [cutoff],
    );
    return res.changes;
  }
}

function defaultAction(type: NotificationType): string {
  switch (type) {
    case 'task_reminder': case 'daily_plan': return 'open_task';
    case 'schedule_start': return 'open_event';
    case 'learning_review': return 'open_learning';
    case 'important_news': case 'daily_digest': return 'open_news';
    case 'goal_review': return 'open_goal';
    case 'project_deadline': return 'open_project';
    default: return 'open_mentor';
  }
}

function minutesBetweenTime(start: string, end: string): number {
  return Math.max(0, timeToMinutes(end) - timeToMinutes(start));
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export { minutesToTime };
