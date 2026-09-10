import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import type { DailySnapshot, MonthlyReview, ProgressSnapshot, Task, WeeklyReview } from '../domain/types';
import type { PersonalizationService } from './personalization';
import type { SettingsService } from './settings';
import { newId } from '../util/id';
import { addDays, dayKey, daysUntil, formatDuration, nowIso, startOfDay, startOfMonth, startOfWeek } from '../util/time';

export interface DayMetrics {
  day: string;
  tasks_planned: number;
  tasks_completed: number;
  tasks_postponed: number;
  tasks_cancelled: number;
  completion_rate: number;
  focus_minutes: number;
  planned_minutes: number;
  learning_minutes: number;
  reviews_done: number;
  events_count: number;
  goal_touches: number;
}

export interface WeekMetrics extends DayMetrics {
  week_start: string;
  days_active: number;
  streak: number;
  plan_accuracy: number;
}

export interface Achievement { id: string; title: string; detail: string; kind: 'streak' | 'milestone' | 'learning' | 'goal' | 'consistency' }

/** Optional narrative generator — wired to the AI orchestrator when available. */
/**
 * Optional narrative generator (wired to the AI orchestrator). Returning `null` means "no wording
 * of your own — the service's deterministic text is better", which is what the offline engine does.
 */
export type NarrativeGenerator = (prompt: { kind: 'daily' | 'weekly' | 'monthly'; data: Record<string, unknown> }) => Promise<string | null>;

/**
 * One sentence of a review, as data instead of prose (req. 77, 78).
 *
 * The engine writes its sentences in English: they are produced once, persisted with the review and
 * read back by the AI context and the JSON export. The user reads the app in their own language, so
 * every sentence is *also* stored as a code plus the numbers behind it, and the client words it
 * (`apps/web/src/lib/review-ru.ts`). Adding a code here means adding its wording there — the client
 * test walks a real review and asserts that every emitted code has a Russian sentence.
 */
export interface ReviewItem {
  code: string;
  params?: Record<string, string | number>;
}

/** Progress + daily/weekly/monthly aggregation (req. 11, 76, 77, 78). */
export class ProgressService {
  constructor(
    private readonly repos: Repos,
    private readonly personalization: PersonalizationService,
    private readonly settings: SettingsService,
  ) {}

  async dayMetrics(day: string): Promise<DayMetrics> {
    const [tasks, events, learning, reviews, history] = await Promise.all([
      this.repos.tasks.find({ scheduled_date: day }, { limit: 500 }),
      this.repos.calendarEvents.find({ day_key: day }, { limit: 200 }),
      this.repos.learningProgress.find({ at: { op: 'between', value: [`${day}T00:00:00`, `${day}T23:59:59`] } }, { limit: 500 }),
      this.repos.learningReviews.find({ last_reviewed_at: { op: 'between', value: [`${day}T00:00:00Z`, `${day}T23:59:59Z`] } }, { limit: 500 }),
      this.repos.taskHistory.find({ at: { op: 'between', value: [`${day}T00:00:00Z`, `${day}T23:59:59Z`] } }, { limit: 1000 }),
    ]);
    const completed = tasks.filter((t) => t.status === 'done');
    const decided = tasks.filter((t) => ['done', 'postponed', 'cancelled'].includes(t.status));
    return {
      day,
      tasks_planned: tasks.length,
      tasks_completed: completed.length,
      tasks_postponed: history.filter((h) => h.action === 'postponed').length,
      tasks_cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      completion_rate: decided.length ? completed.length / decided.length : 0,
      focus_minutes: completed.reduce((acc, t) => acc + Number(t.actual_minutes || t.estimated_minutes || 0), 0),
      planned_minutes: tasks.reduce((acc, t) => acc + Number(t.estimated_minutes || 0), 0),
      learning_minutes: learning.reduce((acc, l) => acc + Number(l.minutes || 0), 0),
      reviews_done: reviews.length,
      events_count: events.length,
      goal_touches: new Set(completed.map((t) => t.goal_id).filter(Boolean)).size,
    };
  }

  async series(days = 14, asOf = new Date()): Promise<DayMetrics[]> {
    const out: DayMetrics[] = [];
    for (let i = days - 1; i >= 0; i--) out.push(await this.dayMetrics(dayKey(addDays(asOf, -i))));
    return out;
  }

  async weekMetrics(weekStart: string): Promise<WeekMetrics> {
    const days: DayMetrics[] = [];
    for (let i = 0; i < 7; i++) days.push(await this.dayMetrics(dayKey(addDays(weekStart, i))));
    const planned = days.reduce((a, d) => a + d.tasks_planned, 0);
    const completed = days.reduce((a, d) => a + d.tasks_completed, 0);
    const decided = completed + days.reduce((a, d) => a + d.tasks_postponed + d.tasks_cancelled, 0);
    const accuracy = days.reduce((a, d) => a + (d.planned_minutes > 0 ? d.focus_minutes / d.planned_minutes : 0), 0) / Math.max(1, days.filter((d) => d.planned_minutes > 0).length);
    return {
      day: weekStart,
      week_start: weekStart,
      tasks_planned: planned,
      tasks_completed: completed,
      tasks_postponed: days.reduce((a, d) => a + d.tasks_postponed, 0),
      tasks_cancelled: days.reduce((a, d) => a + d.tasks_cancelled, 0),
      completion_rate: decided ? completed / decided : 0,
      focus_minutes: days.reduce((a, d) => a + d.focus_minutes, 0),
      planned_minutes: days.reduce((a, d) => a + d.planned_minutes, 0),
      learning_minutes: days.reduce((a, d) => a + d.learning_minutes, 0),
      reviews_done: days.reduce((a, d) => a + d.reviews_done, 0),
      events_count: days.reduce((a, d) => a + d.events_count, 0),
      goal_touches: days.reduce((a, d) => a + d.goal_touches, 0),
      days_active: days.filter((d) => d.tasks_completed > 0 || d.learning_minutes > 0).length,
      streak: await this.streak(),
      plan_accuracy: Number(accuracy.toFixed(2)),
    };
  }

  async monthMetrics(month: string): Promise<{ month: string; weeks: WeekMetrics[]; tasks_completed: number; focus_minutes: number; learning_minutes: number; goals_achieved: number; skill_assessments: number }> {
    const [year, m] = month.split('-').map(Number);
    const first = new Date(year ?? 1970, (m ?? 1) - 1, 1);
    const weeks: WeekMetrics[] = [];
    for (let i = 0; i < 6; i++) {
      const weekStart = dayKey(startOfWeek(addDays(first, i * 7)));
      if (weekStart.slice(0, 7) !== month && i > 0) break;
      weeks.push(await this.weekMetrics(weekStart));
    }
    const [goals, assessments] = await Promise.all([
      this.repos.goals.find({ status: 'achieved' }, { limit: 200 }),
      this.repos.skillAssessments.find({ assessed_at: { op: 'gte', value: `${month}-01` } }, { limit: 500 }),
    ]);
    return {
      month,
      weeks,
      tasks_completed: weeks.reduce((a, w) => a + w.tasks_completed, 0),
      focus_minutes: weeks.reduce((a, w) => a + w.focus_minutes, 0),
      learning_minutes: weeks.reduce((a, w) => a + w.learning_minutes, 0),
      goals_achieved: goals.filter((g) => (g.completed_at ?? '').startsWith(month)).length,
      skill_assessments: assessments.filter((a) => (a.assessed_at ?? '').startsWith(month)).length,
    };
  }

  /** Consecutive days (ending today or yesterday) with at least one completed task or study minute. */
  async streak(asOf = new Date()): Promise<number> {
    let streak = 0;
    for (let i = 0; i < 400; i++) {
      const day = dayKey(addDays(asOf, -i));
      const metrics = await this.dayMetrics(day);
      const active = metrics.tasks_completed > 0 || metrics.learning_minutes > 0;
      if (active) streak += 1;
      else if (i === 0) continue; // today may still be in progress
      else break;
    }
    return streak;
  }

  async achievements(day: string = dayKey()): Promise<Achievement[]> {
    const metrics = await this.dayMetrics(day);
    const streak = await this.streak();
    const out: Achievement[] = [];
    if (metrics.tasks_completed >= 5) out.push({ id: `day_${day}_5`, title: 'Five things done', detail: `${metrics.tasks_completed} tasks completed today`, kind: 'consistency' });
    if (metrics.focus_minutes >= 180) out.push({ id: `day_${day}_focus`, title: 'Deep work day', detail: `${formatDuration(metrics.focus_minutes)} of focused work`, kind: 'consistency' });
    if (metrics.learning_minutes >= 30) out.push({ id: `day_${day}_learn`, title: 'Learning kept alive', detail: `${formatDuration(metrics.learning_minutes)} of study/practice`, kind: 'learning' });
    if (metrics.completion_rate >= 0.9 && metrics.tasks_planned >= 3) out.push({ id: `day_${day}_rate`, title: 'Plan you can trust', detail: `${Math.round(metrics.completion_rate * 100)}% of the plan completed`, kind: 'consistency' });
    for (const milestone of [3, 7, 14, 30, 60, 100]) {
      if (streak === milestone) out.push({ id: `streak_${milestone}`, title: `${milestone}-day streak`, detail: 'Consecutive days with real progress', kind: 'streak' });
    }
    const completedGoals = await this.repos.goals.find({ status: 'achieved', completed_at: { op: 'gte', value: `${day}T00:00:00` } }, { limit: 10 });
    for (const goal of completedGoals) out.push({ id: `goal_${goal.id}`, title: 'Goal achieved', detail: goal.title, kind: 'goal' });
    const doneMilestones = await this.repos.projectMilestones.find({ status: 'done', completed_at: { op: 'gte', value: `${day}T00:00:00` } }, { limit: 10 });
    for (const milestone of doneMilestones) out.push({ id: `milestone_${milestone.id}`, title: 'Milestone reached', detail: milestone.title, kind: 'milestone' });
    return out;
  }

  async snapshot(day: string, ctx: WriteContext = { actor: 'system' }): Promise<ProgressSnapshot> {
    const metrics = await this.dayMetrics(day);
    const existing = await this.repos.progressSnapshots.findOne({ scope: 'day', period_key: day });
    const payload = JSON.stringify({ ...metrics, streak: await this.streak(), achievements: (await this.achievements(day)).length });
    if (existing) {
      await this.repos.progressSnapshots.update(existing.id, { metrics_json: payload, created_at: nowIso() } as never, ctx);
      return { ...existing, metrics_json: payload };
    }
    return this.repos.progressSnapshots.insert({ id: newId(), scope: 'day', period_key: day, metrics_json: payload, created_at: nowIso() } as never, ctx);
  }

  /** Dashboard numbers, computed from stored snapshots + today's live metrics. */
  async overview(): Promise<{
    today: DayMetrics; week: WeekMetrics; streak: number; completion_rate_30d: number;
    focus_last_7d: number; learning_last_7d: number; personalization: string[];
  }> {
    const today = dayKey();
    const [todayMetrics, week, streak, series] = await Promise.all([
      this.dayMetrics(today),
      this.weekMetrics(dayKey(startOfWeek())),
      this.streak(),
      this.series(30),
    ]);
    const last7 = series.slice(-7);
    const rate = await this.personalization.get<number>('completion_rate');
    return {
      today: todayMetrics,
      week,
      streak,
      completion_rate_30d: rate?.value ?? (series.reduce((a, d) => a + d.completion_rate, 0) / Math.max(1, series.length)),
      focus_last_7d: last7.reduce((a, d) => a + d.focus_minutes, 0),
      learning_last_7d: last7.reduce((a, d) => a + d.learning_minutes, 0),
      personalization: await this.personalization.describe(),
    };
  }
}

/**
 * Daily snapshot (req. 11): the day frozen for history, statistics, recovery and AI context.
 * This is derived data — it never replaces the source of truth.
 */
export class SnapshotService {
  constructor(
    private readonly repos: Repos,
    private readonly progress: ProgressService,
    private readonly settings: SettingsService,
    private readonly narrative?: NarrativeGenerator,
  ) {}

  async create(day: string = dayKey(), ctx: WriteContext = { actor: 'system' }): Promise<DailySnapshot> {
    const [tasks, events, changes, goals, projects, learningStats, metrics] = await Promise.all([
      this.repos.tasks.find({ scheduled_date: day }, { limit: 500 }),
      this.repos.calendarEvents.find({ day_key: day }, { limit: 200 }),
      this.repos.changeLog.find({ at: { op: 'between', value: [`${day}T00:00:00Z`, `${day}T23:59:59Z`] } }, { limit: 2000 }),
      this.repos.goals.find({ status: { op: 'in', value: ['active', 'achieved', 'paused'] } }, { limit: 200 }),
      this.repos.projects.find({ status: { op: 'in', value: ['active', 'paused'] } }, { limit: 100 }),
      this.repos.learningProgress.find({ at: { op: 'between', value: [`${day}T00:00:00`, `${day}T23:59:59`] } }, { limit: 500 }),
      this.progress.dayMetrics(day),
    ]);

    const completed = tasks.filter((t) => t.status === 'done').map(compactTask);
    const pending = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map(compactTask);
    const scheduleChanges = changes
      .filter((c) => ['calendar_event', 'task'].includes(c.entity_type) && ['update', 'create', 'delete'].includes(c.action))
      .slice(-40)
      .map((c) => ({ entity: c.entity_type, id: c.entity_id, action: c.action, actor: c.actor, reason: c.reason, at: c.at }));
    const goalChanges = changes.filter((c) => c.entity_type === 'goal').slice(-20)
      .map((c) => ({ id: c.entity_id, action: c.action, reason: c.reason, at: c.at }));
    const achievements = await this.progress.achievements(day);

    const payload = {
      completed_json: JSON.stringify(completed),
      pending_json: JSON.stringify(pending),
      schedule_changes_json: JSON.stringify(scheduleChanges),
      goal_changes_json: JSON.stringify(goalChanges),
      events_json: JSON.stringify(events.map((e) => ({ id: e.id, title: e.title, start: e.starts_at, end: e.ends_at, kind: e.kind, priority: e.priority }))),
      projects_json: JSON.stringify(projects.map((p) => ({ id: p.id, title: p.title, progress: p.progress, health: p.health, deadline: p.deadline }))),
      learning_json: JSON.stringify({ minutes: learningStats.reduce((a, l) => a + Number(l.minutes || 0), 0), entries: learningStats.length }),
      progress_json: JSON.stringify(goals.slice(0, 20).map((g) => ({ id: g.id, title: g.title, horizon: g.horizon, progress: g.progress, status: g.status }))),
      metrics_json: JSON.stringify({ ...metrics, streak: await this.progress.streak(), achievements: achievements.length }),
    };

    const summary = await this.summarize(day, { metrics, completed, pending, achievements, scheduleChanges });
    const existing = await this.repos.dailySnapshots.findOne({ day });
    if (existing) {
      return (await this.repos.dailySnapshots.update(existing.id, { ...payload, summary } as never, { ...ctx, reason: 'daily snapshot updated' }))!;
    }
    return this.repos.dailySnapshots.insert({ id: newId(), day, ...payload, summary } as never, ctx);
  }

  private async summarize(day: string, data: { metrics: DayMetrics; completed: CompactTask[]; pending: CompactTask[]; achievements: Achievement[]; scheduleChanges: unknown[] }): Promise<string> {
    if (this.narrative) {
      try {
        const text = await this.narrative({ kind: 'daily', data: { day, ...data } });
        if (text) return text;
      } catch { /* fall back to the deterministic summary */ }
    }
    const { metrics, completed, pending, achievements } = data;
    const parts = [`${day}: ${metrics.tasks_completed}/${metrics.tasks_planned} planned tasks completed (${formatDuration(metrics.focus_minutes)} focus, ${formatDuration(metrics.learning_minutes)} learning).`];
    if (pending.length) parts.push(`Not finished: ${pending.slice(0, 4).map((t) => t.title).join('; ')}${pending.length > 4 ? ` (+${pending.length - 4} more)` : ''}.`);
    if (metrics.tasks_postponed) parts.push(`${metrics.tasks_postponed} task(s) postponed.`);
    if (achievements.length) parts.push(`Achievements: ${achievements.map((a) => a.title).join(', ')}.`);
    if (metrics.completion_rate >= 0.8 && metrics.tasks_planned >= 3) parts.push('The plan matched reality today.');
    else if (metrics.completion_rate < 0.5 && metrics.tasks_planned >= 3) parts.push('The plan was heavier than the day — tomorrow it should be smaller.');
    return parts.join(' ');
  }

  async get(day: string): Promise<DailySnapshot | null> { return (await this.repos.dailySnapshots.findOne({ day })) ?? null; }
  async list(limit = 30): Promise<DailySnapshot[]> { return (await this.repos.dailySnapshots.find({}, { orderBy: { day: 'desc' }, limit })); }

  /**
   * Create a snapshot for `day`, but only when the day actually contains something (req. 11, 98).
   *
   * A snapshot of a day with no tasks, no events and no learning is noise: it inflates the history
   * the user and the AI have to read, and it says nothing. Empty days are simply not recorded.
   * Returns the snapshot, or null when the day held no activity.
   */
  async createIfActive(day: string = dayKey(), ctx: WriteContext = { actor: 'system' }): Promise<DailySnapshot | null> {
    if (!(await this.dayHadActivity(day))) return null;
    return this.create(day, ctx);
  }

  /** True when anything at all happened on that day — the gate for snapshots and reviews. */
  async dayHadActivity(day: string): Promise<boolean> {
    const metrics = await this.progress.dayMetrics(day);
    return (
      metrics.tasks_planned > 0 || metrics.tasks_completed > 0 || metrics.tasks_postponed > 0
      || metrics.focus_minutes > 0 || metrics.learning_minutes > 0 || metrics.events_count > 0
      || metrics.goal_touches > 0
    );
  }

  /**
   * Backfill the snapshots of days that were missed because the app was closed (req. 11, 13).
   *
   * Called at startup and at every maintenance pass. It deliberately does **not** touch
   * `last_daily_snapshot_day`: that flag means "today's end-of-day snapshot exists" and is owned by
   * the end-of-day path. Conflating the two meant a morning startup suppressed the evening
   * snapshot for the whole day.
   */
  async ensureUpToDate(ctx: WriteContext = { actor: 'system' }, options: { now?: Date; days?: number } = {}): Promise<{ created: string[]; checked: string[]; skipped: boolean }> {
    const flags = await this.settings.get('flags');
    const now = options.now ?? new Date();
    const today = dayKey(now);
    const created: string[] = [];
    const checked: string[] = [];
    if (flags.last_snapshot_check_day === today) return { created, checked, skipped: true };
    for (let i = 1; i <= (options.days ?? 3); i++) {
      const day = dayKey(addDays(now, -i));
      checked.push(day);
      if (await this.repos.dailySnapshots.findOne({ day })) continue;
      const snapshot = await this.createIfActive(day, ctx).catch(() => null);
      if (snapshot) created.push(day);
    }
    // Device-local marker ("this device already looked for missed snapshots today"): it must not
    // travel through sync, or another device would skip its own catch-up run.
    await this.settings.set('flags', { last_snapshot_check_day: today }, { ...ctx, sync: false });
    return { created, checked, skipped: false };
  }
}

/** Weekly review (req. 77) — patterns, not restated statistics. */
export class WeeklyReviewService {
  constructor(
    private readonly repos: Repos,
    private readonly progress: ProgressService,
    private readonly settings: SettingsService,
    private readonly personalization: PersonalizationService,
    private readonly narrative?: NarrativeGenerator,
  ) {}

  async analyze(weekStart: string = dayKey(startOfWeek())): Promise<Record<string, unknown>> {
    const metrics = await this.progress.weekMetrics(weekStart);
    const days = await this.progress.series(7, addDays(weekStart, 6));
    const since = `${weekStart}T00:00:00Z`;
    const until = dayKey(addDays(weekStart, 7));

    const history = await this.repos.taskHistory.find({ at: { op: 'between', value: [since, `${until}T00:00:00Z`] } }, { limit: 3000 });
    const postponed = history.filter((h) => h.action === 'postponed');
    const reasons: Record<string, number> = {};
    for (const h of postponed) reasons[h.reason ?? 'unspecified'] = (reasons[h.reason ?? 'unspecified'] ?? 0) + 1;

    const hourBuckets = new Map<number, { done: number; total: number }>();
    for (const h of history) {
      const hour = new Date(h.at).getHours();
      const bucket = hourBuckets.get(hour) ?? { done: 0, total: 0 };
      bucket.total += 1;
      if (h.action === 'completed') bucket.done += 1;
      hourBuckets.set(hour, bucket);
    }
    const bestHours = [...hourBuckets.entries()]
      .filter(([, v]) => v.total >= 2)
      .map(([hour, v]) => ({ hour, rate: v.done / v.total, total: v.total }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total)
      .slice(0, 3);
    const worstHours = [...hourBuckets.entries()]
      .filter(([, v]) => v.total >= 2)
      .map(([hour, v]) => ({ hour, rate: v.done / v.total, total: v.total }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 2);

    const goals = await this.repos.goals.find({ status: 'active' }, { limit: 100 });
    const untouched: string[] = [];
    for (const goal of goals) {
      const taskCount = await this.repos.tasks.count({ goal_id: goal.id, updated_at: { op: 'gte', value: since } });
      if (taskCount === 0) untouched.push(goal.title);
    }

    const learning = await this.repos.learningProgress.find({ at: { op: 'gte', value: since } }, { limit: 2000 });
    const learningMinutes = learning.reduce((a, l) => a + Number(l.minutes || 0), 0);
    const learningSettings = await this.settings.get('learning');
    const learningTarget = learningSettings.daily_minutes * 7;

    // Each sentence is produced in both shapes at once, from the same condition: English prose for the
    // AI/export, code+numbers for the interface. Two separate `if`s would be two sources of truth and
    // would drift the first time one of them is edited.
    const patterns: string[] = [];
    const patternItems: ReviewItem[] = [];
    const note = (text: string | null, item: ReviewItem | null): void => {
      if (text) patterns.push(text);
      if (item) patternItems.push(item);
    };

    if (metrics.completion_rate < 0.5 && metrics.tasks_planned > 10) {
      const percent = Math.round(metrics.completion_rate * 100);
      note(
        `Only ${percent}% of ${metrics.tasks_planned} planned tasks were completed — the plan is systematically too heavy.`,
        { code: 'plan_too_heavy', params: { percent, planned: metrics.tasks_planned } },
      );
    }
    if (bestHours.length && worstHours.length && bestHours[0].hour !== worstHours[0].hour) {
      const best = bestHours[0];
      const worst = worstHours[0];
      note(
        `Work scheduled around ${best.hour}:00 gets done ${Math.round(best.rate * 100)}% of the time; around ${worst.hour}:00 only ${Math.round(worst.rate * 100)}%.`,
        { code: 'best_hours', params: { best: best.hour, bestRate: Math.round(best.rate * 100), worst: worst.hour, worstRate: Math.round(worst.rate * 100) } },
      );
    }
    const procrastination = reasons.procrastination ?? 0;
    if (procrastination >= 2) {
      note(
        `Procrastination was the stated reason ${procrastination} times — worth looking at what those tasks have in common.`,
        { code: 'procrastination', params: { count: procrastination } },
      );
    }
    if (metrics.plan_accuracy > 1.3) {
      const over = Math.round((metrics.plan_accuracy - 1) * 100);
      note(
        `Actual time ran ~${over}% over estimates.`,
        { code: 'estimate_overrun', params: { percent: over } },
      );
    }
    if (untouched.length) {
      note(
        `No movement on: ${untouched.slice(0, 4).join('; ')}.`,
        { code: 'untouched_goals', params: { count: untouched.length, titles: untouched.slice(0, 4).join('; ') } },
      );
    }
    if (learningMinutes < learningTarget * 0.5 && learningTarget > 0) {
      note(
        `Learning got ${formatDuration(learningMinutes)} of the ${formatDuration(learningTarget)} weekly target.`,
        { code: 'learning_behind', params: { minutes: learningMinutes, target: learningTarget } },
      );
    }
    if (metrics.days_active >= 6) {
      note(
        `Active ${metrics.days_active}/7 days — consistency is the strongest signal this week.`,
        { code: 'consistency', params: { days: metrics.days_active } },
      );
    }

    return { metrics, reasons, bestHours, worstHours, untouchedGoals: untouched, learningMinutes, learningTarget, patterns, pattern_items: patternItems, completed_count: completedTasks(history).length };
  }

  async create(weekStart: string = dayKey(startOfWeek()), ctx: WriteContext = { actor: 'system' }): Promise<WeeklyReview> {
    const analysis = await this.analyze(weekStart);
    const metrics = analysis.metrics as WeekMetrics;
    const patterns = analysis.patterns as string[];
    const history = await this.repos.taskHistory.find({ at: { op: 'gte', value: `${weekStart}T00:00:00Z` } }, { limit: 3000 });
    const completedTasks = history.filter((h) => h.action === 'completed');

    const wentWell: string[] = [];
    const wentWellItems: ReviewItem[] = [];
    const well = (text: string, item: ReviewItem): void => { wentWell.push(text); wentWellItems.push(item); };
    if (completedTasks.length) well(`${completedTasks.length} tasks completed (${formatDuration(metrics.focus_minutes)} of focus).`, { code: 'tasks_completed', params: { count: completedTasks.length, focusMinutes: Math.round(metrics.focus_minutes) } });
    if (metrics.learning_minutes > 0) well(`${formatDuration(metrics.learning_minutes)} spent learning.`, { code: 'learning_time', params: { minutes: Math.round(metrics.learning_minutes) } });
    if (metrics.streak >= 3) well(`${metrics.streak}-day streak.`, { code: 'streak', params: { days: metrics.streak } });
    if (metrics.days_active >= 5) well(`Active ${metrics.days_active} of 7 days.`, { code: 'days_active', params: { days: metrics.days_active } });

    const wentWrong: string[] = [];
    const wentWrongItems: ReviewItem[] = [];
    const wrong = (text: string, item: ReviewItem): void => { wentWrong.push(text); wentWrongItems.push(item); };
    if (metrics.tasks_postponed) wrong(`${metrics.tasks_postponed} tasks postponed.`, { code: 'postponed', params: { count: metrics.tasks_postponed } });
    if (metrics.completion_rate < 0.6 && metrics.tasks_planned >= 5) wrong(`Completion rate ${Math.round(metrics.completion_rate * 100)}%.`, { code: 'completion_rate', params: { percent: Math.round(metrics.completion_rate * 100) } });
    if ((analysis.untouchedGoals as string[]).length) wrong(`${(analysis.untouchedGoals as string[]).length} active goal(s) without movement.`, { code: 'untouched_goals', params: { count: (analysis.untouchedGoals as string[]).length } });

    const nextWeek = await this.nextWeekActions(analysis);
    const narrative = this.narrative
      ? await this.narrative({ kind: 'weekly', data: analysis }).catch(() => null)
      : null;

    const existing = await this.repos.weeklyReviews.findOne({ week_start: weekStart });
    const payload = {
      went_well: JSON.stringify(wentWell),
      went_wrong: JSON.stringify(wentWrong),
      changed: JSON.stringify(patterns),
      blockers: JSON.stringify((analysis.reasons as Record<string, number>)),
      improved: JSON.stringify(nextWeek.improved),
      next_week: JSON.stringify(nextWeek.actions),
      analysis: narrative ?? patterns.join(' '),
      // `patterns` carries the structured side of this review: the sentences above stay English for the
      // AI and the export, while `items` lets the interface word them in the user's language. Old
      // reviews simply have no `items` — the screen then falls back to the numbers it can read.
      patterns: JSON.stringify({
        bestHours: analysis.bestHours, worstHours: analysis.worstHours, reasons: analysis.reasons,
        items: {
          went_well: wentWellItems,
          went_wrong: wentWrongItems,
          changed: (analysis.pattern_items as ReviewItem[]) ?? [],
          next_week: nextWeek.action_items,
          improved: nextWeek.improved_items,
        },
        narrative: narrative ? 'ai' : 'engine',
      }),
      metrics_json: JSON.stringify(metrics),
    };
    if (existing) return (await this.repos.weeklyReviews.update(existing.id, payload as never, { ...ctx, reason: 'weekly review updated' }))!;
    await this.settings.set('flags', { last_weekly_review_week: weekStart }, ctx);
    return this.repos.weeklyReviews.insert({ id: newId(), week_start: weekStart, ...payload } as never, ctx);
  }

  private async nextWeekActions(analysis: Record<string, unknown>): Promise<{ actions: string[]; improved: string[]; action_items: ReviewItem[]; improved_items: ReviewItem[] }> {
    const metrics = analysis.metrics as WeekMetrics;
    const actions: string[] = [];
    const improved: string[] = [];
    const actionItems: ReviewItem[] = [];
    const improvedItems: ReviewItem[] = [];
    const plan = (text: string, item: ReviewItem, better: string, betterItem: ReviewItem): void => {
      actions.push(text); actionItems.push(item);
      improved.push(better); improvedItems.push(betterItem);
    };
    const planning = await this.settings.get('planning');

    if (metrics.completion_rate < 0.6) {
      const suggested = Math.max(60, Math.round((planning.max_focus_hours_per_day * 60) * 0.7));
      plan(
        `Cut the planned daily load to ~${formatDuration(suggested)} and keep only P0/P1 items until the completion rate recovers.`,
        { code: 'cut_load', params: { minutes: suggested } },
        'Smaller daily plan', { code: 'smaller_plan' },
      );
    }
    const best = (analysis.bestHours as { hour: number; rate: number }[])[0];
    if (best) {
      plan(
        `Put the hardest work at ${best.hour}:00 — that is when your completion rate is highest (${Math.round(best.rate * 100)}%).`,
        { code: 'hardest_at_hour', params: { hour: best.hour, rate: Math.round(best.rate * 100) } },
        'Better time-of-day fit', { code: 'time_of_day_fit' },
      );
    }
    const untouched = analysis.untouchedGoals as string[];
    if (untouched.length) {
      actions.push(`Pick ONE of these and give it a concrete 30-minute task this week: ${untouched.slice(0, 3).join(', ')}.`);
      actionItems.push({ code: 'pick_one_goal', params: { titles: untouched.slice(0, 3).join('; '), count: untouched.length } });
    }
    const reasons = analysis.reasons as Record<string, number>;
    if ((reasons.procrastination ?? 0) >= 2) {
      actions.push('For the tasks you keep avoiding, use the 10-minute minimal version instead of the full task.');
      actionItems.push({ code: 'minimal_version', params: { count: reasons.procrastination ?? 0 } });
    }
    if ((metrics.learning_minutes ?? 0) < (analysis.learningTarget as number ?? 0) * 0.5) {
      actions.push('Schedule learning as a fixed calendar block, not as leftover time.');
      actionItems.push({ code: 'schedule_learning', params: { minutes: Math.round(metrics.learning_minutes ?? 0), target: Math.round((analysis.learningTarget as number) ?? 0) } });
    }
    if (!actions.length) {
      actions.push('Keep the current structure — it is producing results.');
      actionItems.push({ code: 'keep_structure' });
    }
    return { actions, improved, action_items: actionItems, improved_items: improvedItems };
  }

  async latest(limit = 8): Promise<WeeklyReview[]> { return this.repos.weeklyReviews.find({}, { orderBy: { week_start: 'desc' }, limit }); }

  /** The review for one specific week, if it exists (used by the mentor and by maintenance). */
  async forWeek(weekStart: string): Promise<WeeklyReview | null> {
    return (await this.repos.weeklyReviews.findOne({ week_start: weekStart })) ?? null;
  }

  /** Did anything happen in that week? Reviews are produced only for weeks with real activity. */
  async weekHadActivity(weekStart: string): Promise<boolean> {
    const metrics = await this.progress.weekMetrics(weekStart);
    return (
      metrics.days_active > 0 || metrics.tasks_completed > 0 || metrics.tasks_planned > 0
      || metrics.focus_minutes > 0 || metrics.learning_minutes > 0 || metrics.tasks_postponed > 0
    );
  }
}

/** Monthly review + strategy proposal (req. 78). */
export class MonthlyReviewService {
  constructor(
    private readonly repos: Repos,
    private readonly progress: ProgressService,
    private readonly settings: SettingsService,
    private readonly narrative?: NarrativeGenerator,
  ) {}

  async create(month: string = dayKey(startOfMonth()).slice(0, 7), ctx: WriteContext = { actor: 'system' }): Promise<MonthlyReview> {
    const metrics = await this.progress.monthMetrics(month);
    const [goals, skills, projects, reviews] = await Promise.all([
      this.repos.goals.find({}, { limit: 200 }),
      this.repos.skills.find({}, { limit: 200 }),
      this.repos.projects.find({}, { limit: 200 }),
      this.repos.weeklyReviews.find({}, { orderBy: { week_start: 'desc' }, limit: 6 }),
    ]);

    const goalSummary = goals.map((g) => ({
      id: g.id, title: g.title, horizon: g.horizon, status: g.status, progress: Number(g.progress),
      target_date: g.target_date,
      overdue: g.target_date ? daysUntil(g.target_date) < 0 && g.status === 'active' : false,
      stale: daysUntil(g.updated_at) < -30 && g.status === 'active',
    }));
    const skillSummary = skills.map((s) => ({ id: s.id, name: s.name, level: Number(s.level), confidence: s.confidence, last_assessment: s.last_assessment_at, due: s.next_assessment_at && s.next_assessment_at <= dayKey() }));
    const projectSummary = projects.map((p) => ({ id: p.id, title: p.title, status: p.status, progress: Number(p.progress), health: p.health, deadline: p.deadline }));

    // English prose for the AI and the export, code+numbers for the interface — same conditions, one
    // place, so the two can never disagree (see `ReviewItem`).
    const priorityChanges: string[] = [];
    const priorityItems: ReviewItem[] = [];
    const notice = (text: string, item: ReviewItem): void => { priorityChanges.push(text); priorityItems.push(item); };
    const staleGoals = goalSummary.filter((g) => g.stale);
    if (staleGoals.length) notice(`${staleGoals.length} active goal(s) had no movement for 30+ days: ${staleGoals.map((g) => g.title).slice(0, 4).join(', ')}. Decide: adjust, pause or archive.`, { code: 'stale_goals', params: { count: staleGoals.length, titles: staleGoals.map((g) => g.title).slice(0, 4).join('; ') } });
    const overdue = goalSummary.filter((g) => g.overdue);
    if (overdue.length) notice(`${overdue.length} goal(s) past their target date: ${overdue.map((g) => g.title).slice(0, 4).join(', ')}.`, { code: 'overdue_goals', params: { count: overdue.length, titles: overdue.map((g) => g.title).slice(0, 4).join('; ') } });
    const dueAssessments = skillSummary.filter((s) => s.due);
    if (dueAssessments.length) notice(`Skill assessments due: ${dueAssessments.map((s) => s.name).slice(0, 5).join(', ')}.`, { code: 'skill_assessments_due', params: { count: dueAssessments.length, names: dueAssessments.map((s) => s.name).slice(0, 5).join('; ') } });
    const stalled = projectSummary.filter((p) => p.health === 'stalled' || p.health === 'at_risk');
    if (stalled.length) notice(`Projects needing a decision: ${stalled.map((p) => `${p.title} (${p.health})`).join(', ')}.`, { code: 'projects_need_decision', params: { count: stalled.length, titles: stalled.map((p) => p.title).slice(0, 4).join('; ') } });

    const proposal = [
      `Month ${month}: ${metrics.tasks_completed} tasks completed, ${formatDuration(metrics.focus_minutes)} of focus, ${formatDuration(metrics.learning_minutes)} of learning, ${metrics.goals_achieved} goal(s) achieved, ${metrics.skill_assessments} skill assessment(s).`,
      ...priorityChanges,
      `Suggested strategy for next month: keep at most 3 active priorities, close or pause what has not moved, and schedule one assessment for the skill that matters most to your top goal.`,
    ].join('\n');

    const narrative = this.narrative ? await this.narrative({ kind: 'monthly', data: { month, metrics, priorityChanges } }).catch(() => null) : null;
    const existing = await this.repos.monthlyReviews.findOne({ month });
    const payload = {
      goals_json: JSON.stringify(goalSummary),
      skills_json: JSON.stringify(skillSummary),
      projects_json: JSON.stringify(projectSummary),
      // The structured form of «что менять в приоритетах» + the suggested strategy. The English
      // sentences stay inside `strategy_proposal` (which the AI and the export read), so nothing is
      // lost by storing codes here instead of prose.
      priority_changes: JSON.stringify({
        items: priorityItems,
        strategy: [{ code: 'strategy_suggestion', params: { maxPriorities: 3 } }],
        narrative: narrative ? 'ai' : 'engine',
      }),
      strategy_proposal: narrative ?? proposal,
      metrics_json: JSON.stringify(metrics),
    };
    if (existing) return (await this.repos.monthlyReviews.update(existing.id, payload as never, { ...ctx, reason: 'monthly review updated' }))!;
    await this.settings.set('flags', { last_monthly_review_month: month }, ctx);
    return this.repos.monthlyReviews.insert({ id: newId(), month, ...payload } as never, ctx);
  }

  async latest(limit = 12): Promise<MonthlyReview[]> { return this.repos.monthlyReviews.find({}, { orderBy: { month: 'desc' }, limit }); }

  /** The review for one specific month, if it exists. */
  async forMonth(month: string): Promise<MonthlyReview | null> {
    return (await this.repos.monthlyReviews.findOne({ month })) ?? null;
  }

  /**
   * A month with nothing in it has nothing to review. Planned-but-unfinished work counts: "I set up
   * a plan and did not follow it" is exactly the kind of pattern a monthly review must name.
   */
  async monthHadActivity(month: string): Promise<boolean> {
    const metrics = await this.progress.monthMetrics(month);
    const planned = metrics.weeks.reduce((a, w) => a + w.tasks_planned, 0);
    const active = metrics.weeks.reduce((a, w) => a + w.days_active, 0);
    const events = metrics.weeks.reduce((a, w) => a + w.events_count, 0);
    return (
      planned > 0 || active > 0 || events > 0
      || metrics.tasks_completed > 0 || metrics.focus_minutes > 0 || metrics.learning_minutes > 0
      || metrics.goals_achieved > 0 || metrics.skill_assessments > 0
    );
  }
}

type CompactTask = ReturnType<typeof compactTask>;

function completedTasks(history: { action: string }[]): { action: string }[] {
  return history.filter((h) => h.action === 'completed');
}

function compactTask(task: Task) {
  return {
    id: task.id, title: task.title, status: task.status, priority: task.priority,
    estimated_minutes: task.estimated_minutes, actual_minutes: task.actual_minutes,
    goal_id: task.goal_id, project_id: task.project_id, kind: task.kind,
    postponed_count: task.postponed_count, reason: task.postpone_reason,
  };
}

export { startOfWeek, startOfMonth, startOfDay };
