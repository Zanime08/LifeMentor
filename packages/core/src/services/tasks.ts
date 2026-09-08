import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { Energy, Priority, SkipReason, Task, TaskStatus } from '../domain/types';
import { SKIP_REASONS } from '../domain/types';
import type { PersonalizationService } from './personalization';
import { newId } from '../util/id';
import { addDays, addMinutes, dateFromDayKey, dayKey, daysUntil, formatTime, nowIso, timeToMinutes } from '../util/time';
import { AppError } from '../util/result';

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(4000).nullish(),
  kind: z.enum(['generic', 'learning', 'practice', 'review', 'project', 'health', 'errand', 'work']).default('generic'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  energy: z.enum(['low', 'medium', 'high']).default('medium'),
  estimated_minutes: z.number().int().min(1).max(16 * 60).default(30),
  goal_id: z.string().nullish(),
  project_id: z.string().nullish(),
  skill_id: z.string().nullish(),
  learning_topic_id: z.string().nullish(),
  due_date: z.string().nullish(),
  due_time: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  scheduled_date: z.string().nullish(),
  scheduled_start: z.string().nullish(),
  scheduled_end: z.string().nullish(),
  strict: z.boolean().default(false),
  recurrence: z.string().nullish(),
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

export const UpdateTaskSchema = CreateTaskSchema.partial().extend({
  status: z.enum(['todo', 'scheduled', 'in_progress', 'done', 'cancelled', 'postponed']).optional(),
  actual_minutes: z.number().int().min(0).max(24 * 60).optional(),
  position: z.number().int().optional(),
});
export type UpdateTaskInput = z.input<typeof UpdateTaskSchema>;

export interface TaskHooks {
  onCompleted?(task: Task): Promise<void>;
  onPostponed?(task: Task, reason: SkipReason): Promise<void>;
  onChanged?(task: Task, action: string): Promise<void>;
}

export interface PostponeResult {
  task: Task;
  required_reason: boolean;
  reason: SkipReason | null;
  mentor_message: string | null;
  minimal_version: { title: string; estimated_minutes: number; task_id?: string } | null;
  rescheduled_to: string | null;
}

const LEGITIMATE_REASONS: SkipReason[] = ['unexpected_event', 'lack_of_time', 'fatigue', 'illness'];

export class TaskService {
  constructor(private readonly repos: Repos, private readonly personalization: PersonalizationService, private readonly hooks: TaskHooks = {}) {}

  async create(input: CreateTaskInput, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const parsed = CreateTaskSchema.parse(input);
    if (parsed.goal_id && !(await this.repos.goals.byId(parsed.goal_id))) throw AppError.notFound('goal', parsed.goal_id);
    if (parsed.project_id && !(await this.repos.projects.byId(parsed.project_id))) throw AppError.notFound('project', parsed.project_id);
    if (parsed.skill_id && !(await this.repos.skills.byId(parsed.skill_id))) throw AppError.notFound('skill', parsed.skill_id);

    const status: TaskStatus = parsed.scheduled_date ? 'scheduled' : 'todo';
    const task = await this.repos.tasks.insert({
      id: newId('task'),
      title: parsed.title,
      notes: parsed.notes ?? null,
      kind: parsed.kind,
      status,
      priority: parsed.priority,
      energy: parsed.energy,
      estimated_minutes: parsed.estimated_minutes,
      actual_minutes: 0,
      goal_id: parsed.goal_id ?? null,
      project_id: parsed.project_id ?? null,
      skill_id: parsed.skill_id ?? null,
      learning_topic_id: parsed.learning_topic_id ?? null,
      due_date: parsed.due_date ?? null,
      due_time: parsed.due_time ?? null,
      scheduled_date: parsed.scheduled_date ?? null,
      scheduled_start: parsed.scheduled_start ?? null,
      scheduled_end: parsed.scheduled_end ?? null,
      completed_at: null,
      postponed_count: 0,
      postpone_reason: null,
      strict: parsed.strict || parsed.priority === 'P0' ? 1 : 0,
      recurrence: parsed.recurrence ?? null,
      last_done_at: null,
      position: 0,
    } as never, { ...ctx, reason: 'task created' });

    await this.recordHistory(task.id, 'created', { to_status: status, actor: ctx.actor });
    await this.hooks.onChanged?.(task, 'created');
    return task;
  }

  async update(id: string, patch: UpdateTaskInput, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const before = await this.repos.tasks.byId(id);
    if (!before) throw AppError.notFound('task', id);
    const parsed = UpdateTaskSchema.parse(patch);
    const record: Record<string, unknown> = { ...parsed };
    if (record.strict !== undefined) record.strict = record.strict ? 1 : 0;
    for (const key of ['notes', 'goal_id', 'project_id', 'skill_id', 'learning_topic_id', 'due_date', 'due_time', 'scheduled_date', 'scheduled_start', 'scheduled_end', 'recurrence']) {
      if (record[key] === undefined) delete record[key];
      else if (record[key] === null) record[key] = null;
    }
    if (parsed.scheduled_date && !parsed.status) record.status = 'scheduled';
    if (parsed.status === 'done' && !before.completed_at) record.completed_at = nowIso();

    const updated = await this.repos.tasks.update(id, record as never, { ...ctx, reason: ctx.reason ?? 'task updated' });
    if (!updated) throw AppError.notFound('task', id);
    if (String(before.status) !== String(updated.status)) {
      await this.recordHistory(id, 'status_changed', { from_status: before.status, to_status: updated.status, actor: ctx.actor });
    }
    await this.hooks.onChanged?.(updated, 'updated');
    return updated;
  }

  async get(id: string): Promise<Task | null> { return (await this.repos.tasks.byId(id)) ?? null; }

  async start(id: string, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const updated = await this.repos.tasks.update(id, { status: 'in_progress' } as never, { ...ctx, reason: 'task started' });
    await this.recordHistory(id, 'started', { from_status: task.status, to_status: 'in_progress', actor: ctx.actor });
    await this.personalization.record('focus_slot', { hour: new Date().getHours(), task_id: id, kind: task.kind, weight: 0.5 }, { type: 'task', id });
    await this.hooks.onChanged?.(updated!, 'started');
    return updated!;
  }

  async complete(id: string, options: { actual_minutes?: number; note?: string } = {}, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const now = new Date();
    const actual = Math.max(0, Math.round(options.actual_minutes ?? task.actual_minutes ?? task.estimated_minutes));

    const record: Record<string, unknown> = { actual_minutes: actual, completed_at: nowIso(), last_done_at: nowIso() };
    if (task.recurrence) {
      // Recurring tasks stay alive: move to the next occurrence instead of marking done forever.
      const next = nextOccurrence(task.recurrence, now);
      record.scheduled_date = next ? dayKey(next) : null;
      record.scheduled_start = null;
      record.scheduled_end = null;
      record.status = 'todo';
    } else {
      record.status = 'done';
    }

    const updated = await this.repos.tasks.update(id, record as never, { ...ctx, reason: 'task completed' });
    if (!updated) throw AppError.notFound('task', id);

    await this.recordHistory(id, 'completed', { from_status: task.status, to_status: String(record.status), note: options.note ?? null, actor: ctx.actor });
    await this.personalization.record('task_completed', {
      minutes: actual,
      estimated_minutes: Number(task.estimated_minutes),
      actual_minutes: actual,
      hour: now.getHours(),
      kind: task.kind,
      priority: task.priority,
      energy: task.energy,
      day: dayKey(now),
      weight: 1,
    }, { type: 'task', id });

    if (task.project_id) await this.repos.projects.update(task.project_id, { last_activity_at: nowIso() } as never, { ...ctx, audit: false });
    await this.hooks.onCompleted?.(updated);
    return updated;
  }

  async reopen(id: string, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const updated = await this.repos.tasks.update(id, { status: 'todo', completed_at: null } as never, { ...ctx, reason: 'task reopened' });
    await this.recordHistory(id, 'reopened', { from_status: task.status, to_status: 'todo', actor: ctx.actor });
    return updated!;
  }

  async cancel(id: string, reason: SkipReason | null, note?: string, ctx: WriteContext = USER_WRITE): Promise<PostponeResult> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const requiresReason = this.isProtected(task);
    if (requiresReason && !reason) {
      return { task, required_reason: true, reason: null, mentor_message: null, minimal_version: null, rescheduled_to: null };
    }
    const updated = await this.repos.tasks.update(id, { status: 'cancelled' } as never, { ...ctx, reason: `cancelled: ${reason ?? 'unspecified'}` });
    await this.recordHistory(id, 'cancelled', { from_status: task.status, to_status: 'cancelled', reason, note: note ?? null, actor: ctx.actor });
    await this.personalization.record('task_cancelled', { kind: task.kind, priority: task.priority, reason }, { type: 'task', id });
    if (reason) await this.personalization.record('strict_reason', { reason, action: 'cancel', priority: task.priority }, { type: 'task', id });
    return {
      task: updated!, required_reason: requiresReason, reason,
      mentor_message: reason ? this.reasonFeedback(reason, task) : null,
      minimal_version: null, rescheduled_to: null,
    };
  }

  /** Strict-mode aware postponement (req. 32). */
  async postpone(id: string, input: { reason?: SkipReason | null; note?: string; new_date?: string | null; keep_time?: boolean } = {}, ctx: WriteContext = USER_WRITE): Promise<PostponeResult> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const requiresReason = this.isProtected(task);
    const reason = (input.reason ?? null) as SkipReason | null;
    if (reason && !SKIP_REASONS.includes(reason)) throw AppError.validation(`Unknown reason: ${reason}`);
    if (requiresReason && !reason) {
      return { task, required_reason: true, reason: null, mentor_message: null, minimal_version: null, rescheduled_to: null };
    }

    const targetDay = input.new_date ?? nextWorkingDay(task.scheduled_date ?? dayKey());
    const record: Record<string, unknown> = {
      status: 'postponed',
      postponed_count: Number(task.postponed_count ?? 0) + 1,
      postpone_reason: reason,
      scheduled_date: targetDay,
      scheduled_start: input.keep_time ? task.scheduled_start : null,
      scheduled_end: input.keep_time ? task.scheduled_end : null,
    };
    const updated = await this.repos.tasks.update(id, record as never, { ...ctx, reason: `postponed: ${reason ?? 'unspecified'}` });
    await this.recordHistory(id, 'postponed', { from_status: task.status, to_status: 'postponed', reason, note: input.note ?? null, actor: ctx.actor });
    await this.personalization.record('task_postponed', { reason, kind: task.kind, priority: task.priority, hour: new Date().getHours(), count: Number(task.postponed_count) + 1 }, { type: 'task', id });

    let minimal: PostponeResult['minimal_version'] = null;
    let message = reason ? this.reasonFeedback(reason, task) : null;

    if (reason === 'procrastination') {
      // Name it honestly, without shaming, and offer the smallest possible next action.
      const suggestion = minimalVersionOf(task);
      const created = await this.create({
        title: suggestion.title,
        notes: `Minimal version of "${task.title}" — the point is to start, not to finish.`,
        kind: task.kind,
        priority: task.priority,
        energy: 'low',
        estimated_minutes: suggestion.estimated_minutes,
        goal_id: task.goal_id ?? undefined,
        project_id: task.project_id ?? undefined,
        skill_id: task.skill_id ?? undefined,
        learning_topic_id: task.learning_topic_id ?? undefined,
        scheduled_date: dayKey(),
      }, { ...ctx, reason: 'minimal version after procrastination' });
      minimal = { ...suggestion, task_id: created.id };
      message = `You postponed "${task.title}" and told me it is procrastination — I will say it plainly: avoiding it will not make it smaller. `
        + `So do not do the whole thing. Do this instead: "${suggestion.title}" (${suggestion.estimated_minutes} minutes), today. `
        + `Starting is the only thing that has to happen now.`;
    } else if (reason === 'fatigue' || reason === 'illness') {
      minimal = minimalVersionOf(task);
      message = `Understood — ${reason === 'illness' ? 'health comes first' : 'rest is part of the work'}. `
        + `I moved "${task.title}" to ${targetDay}. If you still want to touch it, here is a 10-minute version; otherwise leave it.`;
    } else if (reason === 'lack_of_time') {
      message = `Moved to ${targetDay}. If this keeps happening, the plan is too heavy, not you — tell me and I will cut the daily load.`;
    } else if (reason === 'unexpected_event') {
      message = `Noted. "${task.title}" is now on ${targetDay}; I will rebuild the rest of today around what is left.`;
    }

    if (reason) await this.personalization.record('strict_reason', { reason, action: 'postpone', priority: task.priority }, { type: 'task', id });
    await this.hooks.onPostponed?.(updated!, reason ?? 'other');
    return { task: updated!, required_reason: requiresReason, reason, mentor_message: message, minimal_version: minimal, rescheduled_to: targetDay };
  }

  /** Does this task deserve a "why?" before it disappears? */
  isProtected(task: Task): boolean {
    if (task.status === 'done' || task.status === 'cancelled') return false;
    if (task.strict === 1) return true;
    if (task.priority === 'P0' || task.priority === 'P1') return true;
    if (task.due_date && daysUntil(task.due_date) <= 2) return true;
    return Number(task.postponed_count ?? 0) >= 2;
  }

  async reschedule(id: string, slot: { date: string; start?: string | null; end?: string | null }, ctx: WriteContext = USER_WRITE): Promise<Task> {
    const task = await this.repos.tasks.byId(id);
    if (!task) throw AppError.notFound('task', id);
    const start = slot.start ?? task.scheduled_start;
    const end = slot.end ?? (start && task.estimated_minutes ? formatTime(addMinutes(dateFromDayKey(slot.date, ...hm(start)), Number(task.estimated_minutes))) : task.scheduled_end);
    const updated = await this.repos.tasks.update(id, {
      scheduled_date: slot.date, scheduled_start: start ?? null, scheduled_end: end ?? null,
      status: task.status === 'done' || task.status === 'cancelled' ? task.status : 'scheduled',
    } as never, { ...ctx, reason: 'task rescheduled' });
    await this.recordHistory(id, 'rescheduled', { from_status: task.status, to_status: updated?.status ?? task.status, note: `${slot.date} ${start ?? ''}`, actor: ctx.actor });
    await this.hooks.onChanged?.(updated!, 'rescheduled');
    return updated!;
  }

  async listForDay(day: string, options: { includeRecurring?: boolean } = {}): Promise<Task[]> {
    const scheduled = await this.repos.tasks.find({ scheduled_date: day, status: { op: 'not_in', value: ['done', 'cancelled'] } }, { orderBy: { scheduled_start: 'asc', priority: 'asc', position: 'asc' }, limit: 500 });
    if (options.includeRecurring === false) return scheduled;
    const ids = new Set(scheduled.map((t) => t.id));
    const recurring = await this.repos.tasks.find({ recurrence: { op: 'not_null' }, status: { op: 'not_in', value: ['done', 'cancelled'] } }, { limit: 300 });
    for (const task of recurring) {
      if (ids.has(task.id)) continue;
      if (task.last_done_at && dayKey(task.last_done_at) === day) continue;
      if (isDueOn(task.recurrence!, day)) { scheduled.push(task); ids.add(task.id); }
    }
    return scheduled;
  }

  async overdue(asOf = new Date()): Promise<Task[]> {
    const today = dayKey(asOf);
    return this.repos.tasks.find({
      due_date: { op: 'lt', value: today },
      status: { op: 'not_in', value: ['done', 'cancelled'] },
    }, { orderBy: { due_date: 'asc', priority: 'asc' }, limit: 200 });
  }

  async backlog(limit = 200): Promise<Task[]> {
    return this.repos.tasks.find({ scheduled_date: null, status: { op: 'in', value: ['todo', 'postponed'] } }, { orderBy: { priority: 'asc', due_date: 'asc', created_at: 'desc' }, limit });
  }

  /** The next things to do, ordered by when they are scheduled (dashboard + AI context). */
  async next(limit = 8): Promise<Task[]> {
    const horizon = dayKey(addDays(new Date(), 7));
    const scheduled = await this.repos.tasks.find(
      { status: { op: 'not_in', value: ['done', 'cancelled'] }, scheduled_date: { op: 'not_null' } },
      { orderBy: { scheduled_date: 'asc', scheduled_start: 'asc', priority: 'asc' }, limit: 500 },
    );
    return scheduled.filter((t) => t.scheduled_date! <= horizon).slice(0, limit);
  }

  async history(taskId: string, limit = 50): Promise<import('../domain/types').TaskHistory[]> {
    return this.repos.taskHistory.find({ task_id: taskId }, { orderBy: { at: 'desc' }, limit });
  }

  async postponeStats(days = 30): Promise<{ total: number; by_reason: Record<string, number> }> {
    const since = addDays(new Date(), -days).toISOString();
    const rows = await this.repos.taskHistory.find({ action: 'postponed', at: { op: 'gte', value: since } }, { limit: 2000 });
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[r.reason ?? 'unspecified'] = (byReason[r.reason ?? 'unspecified'] ?? 0) + 1;
    return { total: rows.length, by_reason: byReason };
  }

  private async recordHistory(taskId: string, action: string, data: { from_status?: string | null; to_status?: string | null; reason?: SkipReason | null; note?: string | null; actor?: string }): Promise<void> {
    await this.repos.taskHistory.insert({
      id: newId(), task_id: taskId, action,
      from_status: data.from_status ?? null, to_status: data.to_status ?? null,
      reason: data.reason ?? null, note: data.note ?? null, actor: data.actor ?? 'user',
      at: nowIso(), created_at: nowIso(),
    } as never);
  }

  private reasonFeedback(reason: SkipReason, task: Task): string {
    switch (reason) {
      case 'unexpected_event': return `Life happened. "${task.title}" is moved — the plan adapts, the goal does not disappear.`;
      case 'lack_of_time': return `No time today. I moved "${task.title}"; if this repeats three times, we should shrink the plan rather than push harder.`;
      case 'fatigue': return `You are tired — that is information, not a failure. "${task.title}" is moved to a better slot.`;
      case 'illness': return `Recover first. "${task.title}" will wait, and nothing else important is scheduled over your rest.`;
      case 'procrastination': return `You called it procrastination yourself, which is the useful part. Let us make the first step absurdly small.`;
      default: return `"${task.title}" moved. Tell me more if you want the plan to change around it.`;
    }
  }

  /** Compact rendering for the AI context engine. */
  async contextText(limit = 10): Promise<string> {
    const today = dayKey();
    const tasks = await this.repos.tasks.find({ status: { op: 'not_in', value: ['done', 'cancelled'] } }, { orderBy: { priority: 'asc', due_date: 'asc' }, limit: 400 });
    const scored = tasks
      .map((t) => ({ t, score: (t.scheduled_date === today ? 3 : 0) + (t.due_date && daysUntil(t.due_date) <= 1 ? 2 : 0) + (t.priority === 'P0' ? 2 : t.priority === 'P1' ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map(({ t }) => {
      const when = t.scheduled_date ? `${t.scheduled_date}${t.scheduled_start ? ` ${t.scheduled_start}` : ''}` : t.due_date ? `due ${t.due_date}` : 'unscheduled';
      return `- [${t.priority}] ${t.title} — ${when}, ~${t.estimated_minutes}m${t.postponed_count ? `, postponed ${t.postponed_count}×` : ''}`;
    }).join('\n');
  }
}

// ─────────────────────────── recurrence helpers ───────────────────────────
function hm(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/** `daily | weekdays | weekly:<dow>[,<dow>] | monthly:<day>` */
export function isDueOn(recurrence: string, day: string): boolean {
  const date = dateFromDayKey(day);
  const [kind, arg] = recurrence.split(':');
  switch (kind) {
    case 'daily': return true;
    case 'weekdays': { const dow = date.getDay(); return dow >= 1 && dow <= 5; }
    case 'weekly': return (arg ?? '').split(',').map(Number).includes(date.getDay());
    case 'monthly': return date.getDate() === Number(arg);
    default: return false;
  }
}

export function nextOccurrence(recurrence: string, from: Date = new Date()): Date | null {
  for (let i = 1; i <= 400; i++) {
    const candidate = addDays(from, i);
    if (isDueOn(recurrence, dayKey(candidate))) return candidate;
  }
  return null;
}

function nextWorkingDay(fromDay: string): string {
  let candidate = addDays(dateFromDayKey(fromDay), 1);
  for (let i = 0; i < 7; i++) {
    const dow = candidate.getDay();
    if (dow !== 0 && dow !== 6) return dayKey(candidate);
    candidate = addDays(candidate, 1);
  }
  return dayKey(candidate);
}

/** The smallest meaningful version of a task — used when the user admits procrastination. */
export function minimalVersionOf(task: Task): { title: string; estimated_minutes: number } {
  const minutes = Math.max(5, Math.min(15, Math.round(Number(task.estimated_minutes) * 0.15)));
  const verb = task.kind === 'learning' ? 'Read and note one idea from'
    : task.kind === 'practice' ? 'Do one small exercise for'
      : task.kind === 'project' ? 'Open and make one edit to'
        : 'Start';
  return { title: `${verb} "${task.title}" (${minutes} min only)`, estimated_minutes: minutes };
}

/** Human-readable slot label, e.g. "14:00–15:30". */
export function slotLabel(task: Task): string | null {
  if (!task.scheduled_start) return null;
  const end = task.scheduled_end ?? formatTime(addMinutes(dateFromDayKey(task.scheduled_date ?? dayKey(), ...hm(task.scheduled_start)), Number(task.estimated_minutes)));
  return `${task.scheduled_start}–${end}`;
}

export function taskSlotMinutes(task: Task): number {
  if (task.scheduled_start && task.scheduled_end) {
    const start = timeToMinutes(task.scheduled_start);
    const end = timeToMinutes(task.scheduled_end);
    if (end > start) return end - start;
  }
  return Math.max(5, Number(task.estimated_minutes ?? 30));
}

export function taskLocalStart(task: Task): Date | null {
  if (!task.scheduled_date) return null;
  const [h, m] = hm(task.scheduled_start ?? '09:00');
  return dateFromDayKey(task.scheduled_date, h, m);
}

export function taskLocalEnd(task: Task): Date | null {
  const start = taskLocalStart(task);
  if (!start) return null;
  return addMinutes(start, taskSlotMinutes(task));
}
