import { z } from 'zod';
import type { AIOrchestrator, TurnOptions, TurnResult } from './orchestrator';
import type { TaskService } from '../services/tasks';
import type { GoalService } from '../services/goals';
import type { CalendarService } from '../services/calendar';
import type { LearningService } from '../services/learning';
import type { ProgressService, NarrativeGenerator, WeeklyReviewService } from '../services/progress';
import type { NotificationService } from '../services/notifications';
import type { SettingsService } from '../services/settings';
import type { NewsService } from '../services/news';
import type { ProjectService } from '../services/projects';
import type { ProfileService } from '../services/profile';
import type { MemoryService } from '../services/memory';
import type { PlannerService } from '../planning/planner';
import type { NotificationType } from '../domain/types';
import type { WriteContext } from '../db/repo';
import { SYSTEM_WRITE } from '../db/repo';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';
import { addDays, dayKey, daysUntil, formatTime, startOfWeek, timeToMinutes } from '../util/time';

const log = createLogger('ai');

/**
 * Mentor layer (req. 27–29, 49–51, 86).
 *
 * Two modes, one brain:
 *  - **conversational** — `chat()` delegates to the orchestrator (tools, memory, context);
 *  - **proactive** — `evaluateTriggers()` inspects *real* state (calendar, tasks, reviews,
 *    goals, projects, streaks) and produces candidate messages. Every candidate then goes
 *    through the notification gate, so quiet hours, dedupe and the daily budget are enforced
 *    by the same code path as the UI. The mentor cannot spam: a pass sends at most
 *    `maxPerPass` items and never re-sends the same reason inside the dedupe window.
 *
 * Messages are built from data, not invented: each one names the task, event or number it
 * refers to. When a cloud provider is configured, an optional AI narrative is added on top —
 * and if that call fails the deterministic message is still delivered.
 */

export interface MentorDeps {
  orchestrator: AIOrchestrator;
  tasks: TaskService;
  goals: GoalService;
  calendar: CalendarService;
  learning: LearningService;
  progress: ProgressService;
  notifications: NotificationService;
  news: NewsService;
  projects: ProjectService;
  profile: ProfileService;
  memory: MemoryService;
  planner: PlannerService;
  settings: SettingsService;
  deviceId: string;
  /** Optional: lets the proactive pass check whether the previous week already has a review. */
  weeklyReviews?: WeeklyReviewService;
}

export interface MentorTrigger {
  id: string;
  type: NotificationType;
  importance: number;
  title: string;
  body: string;
  reason: string;
  entityType?: string;
  entityId?: string;
  scheduledFor?: string;
}

export interface Briefing {
  kind: 'morning' | 'evening' | 'now';
  day: string;
  title: string;
  text: string;
  facts: Record<string, unknown>;
  /** True when a model wrote part of the text; false = fully deterministic. */
  aiAssisted: boolean;
}

export interface ProactivePassResult {
  evaluated: number;
  delivered: { id: string; trigger: string }[];
  suppressed: { trigger: string; reason: string }[];
}

const NarrativeSchema = z.object({
  summary: z.string().min(1).max(600),
  focus: z.string().min(1).max(240),
  next_step: z.string().min(1).max(240),
});

export class MentorService {
  constructor(private readonly deps: MentorDeps) {}

  // ─────────────────────────── conversation ───────────────────────────
  async chat(text: string, options: TurnOptions = {}): Promise<TurnResult> {
    const settings = await this.deps.settings.all();
    const persona = personaLine(settings.planning.style, settings.planning.reminder_style, settings.ai.language);
    // The persona is injected into the system context, never into the stored user
    // message, so the conversation history stays exactly what the user typed.
    return this.deps.orchestrator.chat(text, {
      ...options,
      extraSystem: options.extraSystem ? `${persona}\n${options.extraSystem}` : persona,
    });
  }

  /** Mentor reaction to a postponement: honest, non-guilt-tripping, offers a smaller step. */
  async reactToPostponement(taskId: string): Promise<{ message: string; minimalVersion: { title: string; minutes: number } | null }> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw AppError.notFound('task', taskId);
    const settings = await this.deps.settings.all();
    const lang = settings.ai.language;
    const postponed = task.postponed_count;
    const minutes = Math.max(5, Math.round(task.estimated_minutes * 0.25 / 5) * 5);
    const minimal = { title: ru(lang) ? `${firstWords(task.title, 4)} — только начать` : `${firstWords(task.title, 4)} — just start`, minutes };
    const message = postponed >= 3
      ? (ru(lang)
        ? `«${task.title}» переносится уже ${postponed}-й раз. Похоже, задача слишком большая или не ваша. Разобьём: первый шаг — ${minutes} мин. Или скажите, если она больше не нужна — уберём из плана.`
        : `"${task.title}" has been postponed ${postponed} times. That usually means it is too big or not actually yours. First step: ${minutes} minutes. Or tell me it no longer matters and I will remove it from the plan.`)
      : (ru(lang)
        ? `Перенёс «${task.title}». Без чувства вины: план подвинется. Если хочешь — сделай только ${minutes}-минутную версию: ${minimal.title}.`
        : `Moved "${task.title}". No guilt needed — the plan adapts. If you want, do only the ${minutes}-minute version: ${minimal.title}.`);
    return { message, minimalVersion: minimal };
  }

  // ─────────────────────────── briefings ───────────────────────────
  /** Morning briefing: what is fixed today, what matters most, what to protect. */
  async morningBriefing(day = dayKey(), options: { ai?: boolean } = {}): Promise<Briefing> {
    const settings = await this.deps.settings.all();
    const lang = settings.ai.language;
    const [events, tasks, overdue, reviewsDue, plan] = await Promise.all([
      this.deps.calendar.listDay(day),
      this.deps.tasks.listForDay(day),
      this.deps.tasks.overdue(),
      this.deps.learning.reviewsDueCount(),
      this.deps.planner.lastPlan(),
    ]);
    const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const top = [...open].sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 3);
    const minutes = open.reduce((sum, t) => sum + t.estimated_minutes, 0);
    const capacity = Math.round(settings.planning.max_focus_hours_per_day * 60) - (plan?.fixed_minutes ?? 0);

    const lines: string[] = [];
    lines.push(ru(lang) ? `Сегодня ${day}.` : `Today is ${day}.`);
    if (events.length) {
      lines.push(ru(lang) ? 'Зафиксировано в календаре:' : 'Fixed in your calendar:');
      for (const event of events.slice(0, 6)) {
        lines.push(`• ${event.all_day ? (ru(lang) ? 'весь день' : 'all day') : `${event.starts_at.slice(11, 16)}–${event.ends_at.slice(11, 16)}`} — ${event.title}`);
      }
    }
    if (overdue.length) lines.push(ru(lang) ? `Просрочено: ${overdue.length} (${overdue.slice(0, 3).map((t) => t.title).join(', ')}).` : `Overdue: ${overdue.length} (${overdue.slice(0, 3).map((t) => t.title).join(', ')}).`);
    if (top.length) {
      lines.push(ru(lang) ? 'Главное сегодня:' : 'What matters most today:');
      for (const task of top) lines.push(`• [${task.priority}] ${task.title} (~${task.estimated_minutes} мин)`);
    }
    if (reviewsDue > 0) lines.push(ru(lang) ? `Повторений к выполнению: ${reviewsDue}.` : `Spaced-repetition reviews due: ${reviewsDue}.`);
    if (minutes > capacity && capacity > 0) {
      lines.push(ru(lang)
        ? `Внимание: задач на ${minutes} мин, а реальная ёмкость около ${capacity} мин. Часть придётся перенести — скажи, что важнее.`
        : `Careful: ${minutes} minutes of tasks against roughly ${capacity} minutes of real capacity. Something will have to move — tell me what matters most.`);
    }
    lines.push(ru(lang)
      ? `Свободное время защищено: ${settings.planning.free_time_minutes} мин сегодня.`
      : `Protected free time today: ${settings.planning.free_time_minutes} minutes.`);

    const facts = { events: events.length, tasks: open.length, minutes, capacity, overdue: overdue.length, reviews_due: reviewsDue };
    const text = lines.join('\n');
    const narrative = options.ai === false ? null : await this.aiNarrative('morning', facts, lang).catch(() => null);
    return {
      kind: 'morning', day, title: ru(lang) ? 'План на день' : 'Your day',
      text: narrative ? `${narrative}\n\n${text}` : text, facts, aiAssisted: Boolean(narrative),
    };
  }

  /** Evening review: what actually happened, what slipped, what to prepare. */
  async eveningReview(day = dayKey(), options: { ai?: boolean } = {}): Promise<Briefing> {
    const settings = await this.deps.settings.all();
    const lang = settings.ai.language;
    const [metrics, postponedStats, tomorrow] = await Promise.all([
      this.deps.progress.dayMetrics(day),
      this.deps.tasks.postponeStats(7),
      this.deps.calendar.listDay(dayKey(addDays(new Date(`${day}T12:00:00`), 1))),
    ]);
    const lines: string[] = [];
    lines.push(ru(lang)
      ? `Выполнено ${metrics.tasks_completed} из ${metrics.tasks_planned} задач (${Math.round(metrics.completion_rate * 100)}%), ${metrics.focus_minutes} мин фокуса, ${metrics.learning_minutes} мин обучения.`
      : `Completed ${metrics.tasks_completed} of ${metrics.tasks_planned} tasks (${Math.round(metrics.completion_rate * 100)}%), ${metrics.focus_minutes} minutes of focus, ${metrics.learning_minutes} minutes of learning.`);
    if (metrics.tasks_postponed > 0) {
      const main = Object.entries(postponedStats.by_reason).sort((a, b) => b[1] - a[1])[0];
      lines.push(ru(lang)
        ? `Перенесено: ${metrics.tasks_postponed}${main ? `, чаще всего — «${main[0]}» (${main[1]}×)` : ''}.`
        : `Postponed: ${metrics.tasks_postponed}${main ? `, most often "${main[0]}" (${main[1]}×)` : ''}.`);
    }
    if (tomorrow.length) {
      lines.push(ru(lang) ? 'Завтра уже зафиксировано:' : 'Already fixed for tomorrow:');
      for (const event of tomorrow.slice(0, 4)) lines.push(`• ${event.all_day ? (ru(lang) ? 'весь день' : 'all day') : event.starts_at.slice(11, 16)} — ${event.title}`);
    }
    const streak = await this.deps.progress.streak();
    if (streak >= 2) lines.push(ru(lang) ? `Серия: ${streak} дн. подряд.` : `Streak: ${streak} days in a row.`);

    const facts = { ...metrics, streak, postponed_7d: postponedStats.total };
    const text = lines.join('\n');
    const narrative = options.ai === false ? null : await this.aiNarrative('evening', facts, lang).catch(() => null);
    return { kind: 'evening', day, title: ru(lang) ? 'Итоги дня' : 'Day review', text: narrative ? `${narrative}\n\n${text}` : text, facts, aiAssisted: Boolean(narrative) };
  }

  // ─────────────────────────── proactive mentor ───────────────────────────
  /** Inspect real state and produce candidate messages, most important first. */
  async evaluateTriggers(now = new Date()): Promise<MentorTrigger[]> {
    const settings = await this.deps.settings.all();
    const lang = settings.ai.language;
    const day = dayKey(now);
    const triggers: MentorTrigger[] = [];
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();

    // 1. Something starts soon — the highest-value reminder there is.
    const nextEvent = await this.deps.calendar.nextEvent(now);
    if (nextEvent) {
      const lead = Math.round((new Date(nextEvent.starts_at).getTime() - now.getTime()) / 60000);
      if (lead > 0 && lead <= 30) {
        triggers.push({
          id: `event_start_${nextEvent.id}`, type: 'schedule_start', importance: lead <= 10 ? 0.8 : 0.6,
          title: ru(lang) ? `Через ${lead} мин: ${nextEvent.title}` : `In ${lead} min: ${nextEvent.title}`,
          body: ru(lang)
            ? `${nextEvent.title} начинается в ${formatTime(nextEvent.starts_at)}${nextEvent.location ? `, ${nextEvent.location}` : ''}.`
            : `${nextEvent.title} starts at ${formatTime(nextEvent.starts_at)}${nextEvent.location ? `, ${nextEvent.location}` : ''}.`,
          reason: 'event_starting_soon', entityType: 'event', entityId: nextEvent.id,
        });
      }
    }

    // 2. A scheduled task should be starting.
    const todays = (await this.deps.tasks.listForDay(day)).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const starting = todays.find((t) => t.scheduled_start && Math.abs(timeToMinutes(t.scheduled_start) - minuteOfDay) <= 5);
    if (starting) {
      triggers.push({
        id: `task_start_${starting.id}`, type: 'schedule_start', importance: 0.7,
        title: ru(lang) ? `Время: ${starting.title}` : `Time to start: ${starting.title}`,
        body: ru(lang)
          ? `${starting.title} — ${starting.estimated_minutes} мин, приоритет ${starting.priority}.${starting.notes ? ` Заметка: ${starting.notes.slice(0, 80)}` : ''}`
          : `${starting.title} — ${starting.estimated_minutes} min, priority ${starting.priority}.${starting.notes ? ` Note: ${starting.notes.slice(0, 80)}` : ''}`,
        reason: 'task_starting', entityType: 'task', entityId: starting.id,
      });
    }

    // 3. High-priority work is overdue.
    const overdue = await this.deps.tasks.overdue(now);
    const critical = overdue.filter((t) => t.priority === 'P0' || t.priority === 'P1').slice(0, 3);
    if (critical.length) {
      triggers.push({
        id: `overdue_${day}`, type: 'task_reminder', importance: 0.8,
        title: ru(lang) ? `Просрочено важных: ${critical.length}` : `${critical.length} important overdue tasks`,
        body: critical.map((t) => `• ${t.title} (${ru(lang) ? 'срок' : 'due'} ${t.due_date})`).join('\n'),
        reason: 'overdue_priority', entityType: 'task', entityId: critical[0].id,
      });
    }

    // 4. Spaced repetition is due — forgetting is silent, so the system speaks.
    const due = await this.deps.learning.reviewsDueCount(now);
    if (due > 0) {
      triggers.push({
        id: `reviews_${day}`, type: 'learning_review', importance: Math.min(0.75, 0.45 + due / 40),
        title: ru(lang) ? `Повторений: ${due}` : `${due} reviews due`,
        body: ru(lang)
          ? `${due} карточек ждут повторения. 10 минут сейчас экономят час переучивания позже.`
          : `${due} cards are waiting. Ten minutes now saves an hour of relearning later.`,
        reason: 'reviews_due',
      });
    }

    // 5. Streak at risk late in the day.
    if (minuteOfDay >= 18 * 60) {
      const metrics = await this.deps.progress.dayMetrics(day);
      const streak = await this.deps.progress.streak(now);
      if (streak >= 3 && metrics.tasks_completed === 0) {
        const smallest = [...todays].sort((a, b) => a.estimated_minutes - b.estimated_minutes)[0];
        triggers.push({
          id: `streak_${day}`, type: 'mentor_message', importance: 0.75,
          title: ru(lang) ? `Серия ${streak} дн. под угрозой` : `${streak}-day streak at risk`,
          body: smallest
            ? (ru(lang) ? `Сегодня ещё ничего не закрыто. Самая короткая задача — «${smallest.title}» (${smallest.estimated_minutes} мин).` : `Nothing closed yet today. The shortest task is "${smallest.title}" (${smallest.estimated_minutes} min).`)
            : (ru(lang) ? 'Сегодня ещё ничего не закрыто. Даже 10 минут сохраняют серию.' : 'Nothing closed yet today. Even 10 minutes keeps the streak alive.'),
          reason: 'streak_at_risk', entityType: smallest ? 'task' : undefined, entityId: smallest?.id,
        });
      }
    }

    // 6. A goal has gone quiet.
    const stale = await this.deps.goals.stale(14);
    if (stale.length) {
      const goal = stale[0];
      triggers.push({
        id: `goal_stale_${goal.id}`, type: 'goal_review', importance: 0.65,
        title: ru(lang) ? `Цель «${goal.title}» без движения` : `Goal "${goal.title}" has stalled`,
        body: ru(lang)
          ? `${daysSinceText(goal.updated_at, lang)} изменений нет, прогресс ${Math.round(Number(goal.progress))}%. Продолжаем, меняем шаг или закрываем?`
          : `No movement ${daysSinceText(goal.updated_at, lang)}, progress ${Math.round(Number(goal.progress))}%. Keep it, change the next step, or close it?`,
        reason: 'goal_stalled', entityType: 'goal', entityId: goal.id,
      });
    }

    // 7. A project deadline is close.
    const deadlines = await this.deps.projects.upcomingDeadlines(3);
    for (const project of deadlines.slice(0, 2)) {
      if (!project.deadline) continue;
      triggers.push({
        id: `project_deadline_${project.id}`, type: 'project_deadline', importance: 0.8,
        title: ru(lang) ? `Дедлайн «${project.title}»` : `Deadline: ${project.title}`,
        body: ru(lang)
          ? `${daysUntil(project.deadline)} дн. до ${project.deadline}, готовность ${Math.round(Number(project.progress))}%.`
          : `${daysUntil(project.deadline)} days until ${project.deadline}, ${Math.round(Number(project.progress))}% complete.`,
        reason: 'project_deadline', entityType: 'project', entityId: project.id,
      });
    }

    // 8. The day has no plan yet.
    const plan = await this.deps.planner.lastPlan();
    const noPlan = !plan || plan.day !== day;
    if (noPlan && minuteOfDay >= timeToMinutes(settings.planning.work_start) && minuteOfDay < timeToMinutes(settings.planning.work_end)) {
      triggers.push({
        id: `no_plan_${day}`, type: 'daily_plan', importance: 0.6,
        title: ru(lang) ? 'Собрать план на день?' : "Build today's plan?",
        body: ru(lang)
          ? `Задач в очереди: ${todays.length}. Скажи «спланируй день» — соберу расписание с учётом календаря и свободного времени.`
          : `${todays.length} tasks in the queue. Say "plan my day" and I will build a schedule around your calendar and free time.`,
        reason: 'day_not_planned',
      });
    }

    // 9. Important news the user chose to follow.
    if (settings.news.enabled && settings.news.urgent_push) {
      const urgent = await this.deps.news.urgent(2);
      const unread = urgent.filter((n) => !n.read_at);
      if (unread.length) {
        triggers.push({
          id: `news_${unread[0].id}`, type: 'important_news', importance: 0.7,
          title: unread[0].title,
          body: ru(lang) ? `Важное по вашим темам: ${unread.map((n) => n.title).join('; ')}` : `Important in the topics you follow: ${unread.map((n) => n.title).join('; ')}`,
          reason: 'urgent_news', entityType: 'news', entityId: unread[0].id,
        });
      }
    }

    // 10. Weekly review is due. The subject is the week that just ENDED, because a review of a week
    //     that started this morning has nothing to look at; maintenance produces it automatically a
    //     day later, so this trigger only speaks up when that has not happened yet.
    const previousWeek = dayKey(addDays(startOfWeek(now), -7));
    const reviewedWeek = this.deps.weeklyReviews
      ? Boolean(await this.deps.weeklyReviews.forWeek(previousWeek))
      : settings.flags.last_weekly_review_week === previousWeek;
    if (!reviewedWeek && (now.getDay() === 0 || now.getDay() === 1)) {
      triggers.push({
        id: `weekly_review_${previousWeek}`, type: 'goal_review', importance: 0.55,
        title: ru(lang) ? 'Время недельного разбора' : 'Time for the weekly review',
        body: ru(lang)
          ? 'Посмотрим, что сработало на прошедшей неделе, а что мешало, и скорректируем цели.'
          : 'Let us look at what worked last week, what got in the way, and adjust the goals.',
        reason: 'weekly_review_due',
      });
    }

    return triggers.sort((a, b) => b.importance - a.importance);
  }

  /**
   * Run one proactive pass: evaluate → gate → deliver. The notification service
   * decides what actually reaches the user (quiet hours, per-type prefs, dedupe,
   * daily budget), so this method never bypasses those rules.
   */
  async proactivePass(options: { now?: Date; maxPerPass?: number; write?: WriteContext } = {}): Promise<ProactivePassResult> {
    const now = options.now ?? new Date();
    const write = options.write ?? SYSTEM_WRITE;
    const settings = await this.deps.settings.all();
    if (!settings.notifications.enabled || !settings.notifications.proactive_mentor) {
      return { evaluated: 0, delivered: [], suppressed: [] };
    }
    const triggers = await this.evaluateTriggers(now);
    const delivered: { id: string; trigger: string }[] = [];
    const suppressed: { trigger: string; reason: string }[] = [];
    const max = options.maxPerPass ?? 3;

    for (const trigger of triggers) {
      if (delivered.length >= max) { suppressed.push({ trigger: trigger.reason, reason: 'pass_limit' }); continue; }
      const decision = await this.deps.notifications.create({
        type: trigger.type,
        title: trigger.title,
        body: trigger.body,
        importance: trigger.importance,
        scheduled_at: trigger.scheduledFor ?? null,
        channel: 'in_app',
        entity_type: trigger.entityType ?? null,
        entity_id: trigger.entityId ?? null,
        dedupe_key: trigger.id,
        context: { reason: trigger.reason, source: 'mentor' },
      }, write);
      if (decision.delivered) delivered.push({ id: decision.notification.id, trigger: trigger.reason });
      else suppressed.push({ trigger: trigger.reason, reason: decision.reason });
    }

    if (delivered.length || suppressed.length) {
      log.debug('proactive pass', { delivered: delivered.length, suppressed: suppressed.length, evaluated: triggers.length });
    }
    return { evaluated: triggers.length, delivered, suppressed };
  }

  // ─────────────────────────── narrative generator ───────────────────────────
  /**
   * NarrativeGenerator for the review services: the deterministic analysis stays the
   * source of truth, the model only phrases it. If the model is unavailable the
   * review is still created with its computed findings.
   */
  narrativeGenerator(): NarrativeGenerator {
    return async ({ kind, data }) => {
      const settings = await this.deps.settings.all();
      const lang = settings.ai.language;
      try {
        const result = await this.deps.orchestrator.structured(
          kind === 'daily' ? 'summarize_day' : kind === 'weekly' ? 'summarize_week' : 'summarize_month',
          `Write a short, concrete ${kind} review for the user in ${lang}. Use ONLY the numbers in the data. No praise inflation, no invented facts, no promises. Summary max 3 sentences, then the single most useful focus and the next step.`,
          NarrativeSchema,
          { tier: 'mid', extra: data, maxTokens: 500 },
        );
        return [result.data.summary, ru(lang) ? `Фокус: ${result.data.focus}` : `Focus: ${result.data.focus}`, ru(lang) ? `Следующий шаг: ${result.data.next_step}` : `Next step: ${result.data.next_step}`].join('\n');
      } catch (error) {
        log.warn('narrative generation failed, using deterministic text', { kind, error: error instanceof Error ? error.message : String(error) });
        return fallbackNarrative(kind, data, lang);
      }
    };
  }

  private async aiNarrative(kind: 'morning' | 'evening', facts: Record<string, unknown>, language: string): Promise<string | null> {
    const result = await this.deps.orchestrator.structured(
      kind === 'morning' ? 'summarize_day' : 'summarize_week',
      kind === 'morning'
        ? `Write one short motivating but factual opening for today's plan in ${language}. Max 2 sentences, no clichés, no invented facts.`
        : `Write one short honest closing remark about the day in ${language}. Max 2 sentences. Acknowledge what was done, do not scold.`,
      z.object({ opening: z.string().min(1).max(300) }),
      { tier: 'cheap', extra: facts, maxTokens: 200 },
    );
    const text = result.data.opening.trim();
    return text.length > 3 ? text : null;
  }
}

// ─────────────────────────── helpers ───────────────────────────
function ru(language?: string | null): boolean { return (language ?? 'en').toLowerCase().startsWith('ru'); }

function personaLine(style: string, reminderStyle: string, language?: string | null): string {
  const russian = ru(language);
  const tone = style === 'strict'
    ? (russian ? 'Тон: прямой и требовательный, называй вещи своими именами.' : 'Tone: direct and demanding, call things by their names.')
    : style === 'flexible'
      ? (russian ? 'Тон: мягкий, предлагай варианты, не дави.' : 'Tone: gentle, offer options, do not push.')
      : (russian ? 'Тон: спокойный и поддерживающий, но честный.' : 'Tone: calm and supportive, but honest.');
  const reminders = reminderStyle === 'none'
    ? (russian ? 'Напоминания не отправляй.' : 'Do not send reminders.')
    : reminderStyle === 'firm'
      ? (russian ? 'Напоминания: чёткие, с конкретным временем.' : 'Reminders: firm, with a concrete time.')
      : (russian ? 'Напоминания: короткие и ненавязчивые.' : 'Reminders: short and unobtrusive.');
  return `${tone} ${reminders}`;
}

function firstWords(text: string, count: number): string {
  const words = text.split(/\s+/).slice(0, count);
  return words.join(' ');
}

function daysSinceText(iso: string, language?: string | null): string {
  const days = Math.max(0, daysUntil(iso.slice(0, 10)) * -1);
  return ru(language) ? `${days} дн.` : `${days}d`;
}

function fallbackNarrative(kind: string, data: Record<string, unknown>, language?: string | null): string {
  const metrics = data as Record<string, number | undefined>;
  const completed = metrics.tasks_completed ?? 0;
  const planned = metrics.tasks_planned ?? 0;
  const focus = metrics.focus_minutes ?? 0;
  if (ru(language)) {
    return kind === 'daily'
      ? `Итог дня: ${completed} из ${planned} ${pluralRu(planned, 'задача', 'задачи', 'задач')}, ${focus} мин фокуса.`
      : `Итог периода: ${completed} ${pluralRu(completed, 'задача', 'задачи', 'задач')}, ${focus} мин фокуса.`;
  }
  return kind === 'daily'
    ? `Day result: ${completed} of ${planned} tasks, ${focus} minutes of focus.`
    : `Period result: ${completed} tasks, ${focus} minutes of focus.`;
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
