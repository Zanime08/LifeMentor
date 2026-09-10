import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { DayPlan, Energy, PlannedSlot, Priority, Task } from '../domain/types';
import type { PlanNote } from './plan-text';
import { PRIORITY_WEIGHT, ENERGY_COST } from '../domain/types';
import type { CalendarService, BusyBlock } from '../services/calendar';
import type { TaskService } from '../services/tasks';
import type { LearningService } from '../services/learning';
import type { SettingsService } from '../services/settings';
import type { PersonalizationService } from '../services/personalization';
import { dayKey, daysUntil, minutesToTime, nowIso, timeToMinutes } from '../util/time';
import { createLogger } from '../util/logging';

/**
 * The stored day plan is compared ignoring `generated_at`: rebuilding an unchanged day must be a
 * read. Returns the timestamp of the stored plan so the caller can hand back exactly what is in
 * the database.
 */
function planGeneratedAt(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { generated_at?: unknown };
    return typeof parsed.generated_at === 'string' ? parsed.generated_at : null;
  } catch { return null; }
}

function planEqualsIgnoringTimestamp(a: string, b: string): boolean {
  const strip = (json: string): string | null => {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      delete parsed.generated_at;
      return JSON.stringify(parsed);
    } catch { return null; }
  };
  const left = strip(a);
  return left !== null && left === strip(b);
}

export interface PlannerDeps {
  repos: Repos;
  calendar: CalendarService;
  tasks: TaskService;
  learning: LearningService;
  settings: SettingsService;
  personalization: PersonalizationService;
}

export interface ScoredTask {
  task: Task;
  score: number;
  /** English, for the AI context and the export — the user reads `reason_items`. */
  reasons: string[];
  reason_items: PlanNote[];
  minutes: number;
  /** Hours of day this task should preferably start in (energy fit). */
  preferredHours: number[];
}

export interface PlannerOptions {
  /** Only plan from this moment forward (adaptive rescheduling). */
  now?: Date;
  /** Skip persisting the plan to tasks (dry run / preview). */
  dryRun?: boolean;
  /**
   * Persist even when `now` is inside a `dryRun`. The plan computed with `{ now, dryRun: true }`
   * is the exact one to persist later: rebuilding it without `now` at the end of the day would
   * re-place tasks into the hours that are already gone. Used by adaptive rescheduling.
   */
  persist?: boolean;
  /** Extra tasks to consider (e.g. minimal versions offered by the mentor). */
  extraCandidates?: Task[];
}

const DEFAULT_FREE_MINUTES = 90;
const REVIEW_BLOCK_MINUTES = 15;

/**
 * Daily planner (req. 30, 31, 33, 34, 82, 83, 84).
 *
 * Hard rules encoded here:
 *  1. a real calendar event is never overlapped (critical events are absolutely immovable);
 *  2. the day is bounded by physical capacity: waking hours − fixed blocks − protected free time;
 *  3. the planned focus load is capped by what the user *actually* completes (personalization),
 *     so the system stops producing impossible schedules;
 *  4. free time is protected, not left over by accident;
 *  5. priority is a blend of importance, urgency, goal alignment, deadline, skill value and energy —
 *     never urgency alone.
 */
export class PlannerService {
  private readonly log = createLogger('planner');

  constructor(private readonly deps: PlannerDeps) {}

  /**
   * Build (and persist) the plan for a day.
   *
   * Serialised on purpose: the dashboard, the Today screen, onboarding and the mentor's
   * `plan_day` tool can all ask for a plan within the same second, and each build spans one
   * write transaction. Queueing them keeps every caller's writes in its own transaction instead
   * of silently joining someone else's (see `Database.transaction`'s concurrency contract).
   */
  async buildDay(day: string = dayKey(), options: PlannerOptions = {}): Promise<DayPlan> {
    return this.deps.repos.db.runExclusive(() => this.buildDayNow(day, options));
  }

  /** The actual build. Callers that already hold the planner's turn (rebuild) use this directly. */
  private async buildDayNow(day: string = dayKey(), options: PlannerOptions = {}): Promise<DayPlan> {
    const { repos, calendar, tasks, learning, settings, personalization } = this.deps;
    const planning = await settings.get('planning');
    const learningSettings = await settings.get('learning');
    const now = options.now ?? new Date();
    const isToday = day === dayKey(now);
    const startBound = isToday && options.now ? clampMinutes(now.getHours() * 60 + now.getMinutes()) : timeToMinutes(planning.wake_time);
    const endBound = timeToMinutes(planning.sleep_time) <= startBound ? 24 * 60 : timeToMinutes(planning.sleep_time);

    // 1. Reality first: calendar blocks.
    const busy = (await calendar.busyBlocks(day)).filter((b) => b.end > startBound && b.start < endBound);
    const fixedMinutes = mergeMinutes(busy.map((b) => ({ start: Math.max(b.start, startBound), end: Math.min(b.end, endBound) })));
    const freeWindows = windowsBetween(busy, startBound, endBound, planning.buffer_minutes);

    // 2. Personalized, physically possible capacity (req. 83).
    const loadSignal = await personalization.get<number>('realistic_daily_load');
    const accuracy = await personalization.get<number>('plan_accuracy');
    const observedLoad = loadSignal && loadSignal.evidence_count >= 3 ? loadSignal.value : null;
    const focusCap = Math.min(
      planning.max_focus_hours_per_day * 60,
      observedLoad !== null ? Math.round(observedLoad * (accuracy && accuracy.value > 1.2 ? 0.9 : 1.1)) : planning.max_focus_hours_per_day * 60,
    );
    const protectedFree = planning.free_time_minutes || DEFAULT_FREE_MINUTES;
    const rawCapacity = Math.max(0, (endBound - startBound) - fixedMinutes - planning.buffer_minutes * Math.max(0, freeWindows.length - 1));
    const capacity = Math.max(0, Math.min(rawCapacity - protectedFree, focusCap));

    // 3. Candidates.
    const candidates = await this.collectCandidates(day, options);
    const scored = this.score(candidates, { day, planning, now, personalizationBest: (await personalization.get<number[]>('best_focus_hours'))?.value ?? [] });

    // 4. Fill windows.
    const slots: PlannedSlot[] = [];
    for (const block of busy) {
      slots.push({
        start: minutesToTime(Math.max(block.start, startBound)),
        end: minutesToTime(Math.min(block.end, endBound)),
        kind: 'event',
        title: block.title,
        eventId: block.id,
        immovable: block.immovable,
        note: block.immovable ? 'fixed commitment — nothing is scheduled over this' : undefined,
        note_items: block.immovable ? [{ code: 'fixed_commitment' }] : undefined,
      });
    }

    const deferred: DayPlan['deferred'] = [];
    const placements = new Map<string, { start: number; end: number }>();
    let remainingCapacity = capacity;
    let focusMinutes = 0;
    let sinceBreak = 0;
    const warnings: string[] = [];
    const warningItems: PlanNote[] = [];

    for (const scoredTask of scored) {
      if (remainingCapacity <= 5) {
        deferred.push({
          task_id: scoredTask.task.id, title: scoredTask.task.title,
          reason: 'today is full — the plan is capped by what the day physically holds',
          reason_items: [{ code: 'day_full' }],
        });
        continue;
      }
      const minutes = Math.min(scoredTask.minutes, remainingCapacity);
      if (minutes < 10) {
        deferred.push({
          task_id: scoredTask.task.id, title: scoredTask.task.title,
          reason: 'less than 10 minutes of capacity left',
          reason_items: [{ code: 'no_room' }],
        });
        continue;
      }

      const placement = findPlacement(freeWindows, placements, minutes, scoredTask.task.energy, planning.buffer_minutes, scoredTask.preferredHours);
      if (!placement) {
        deferred.push({
          task_id: scoredTask.task.id, title: scoredTask.task.title,
          reason: `no continuous ${minutes}-minute block left (day is full)`,
          reason_items: [{ code: 'no_block', params: { minutes } }],
        });
        continue;
      }
      placements.set(scoredTask.task.id, placement);
      slots.push({
        start: minutesToTime(placement.start),
        end: minutesToTime(placement.end),
        kind: 'task',
        title: scoredTask.task.title,
        taskId: scoredTask.task.id,
        priority: scoredTask.task.priority,
        energy: scoredTask.task.energy,
        note: scoredTask.reasons.join(' · '),
        note_items: scoredTask.reason_items,
      });
      remainingCapacity -= minutes;
      focusMinutes += minutes;
      sinceBreak += minutes;

      if (sinceBreak >= planning.break_every_minutes) {
        const breakSlot = findPlacement(freeWindows, placements, 10, 'low', 0, []);
        if (breakSlot) {
          placements.set(`break_${placement.end}`, breakSlot);
          slots.push({
            start: minutesToTime(breakSlot.start), end: minutesToTime(breakSlot.end), kind: 'break', title: 'Break',
            generated_title: { code: 'break', params: { minutes: breakSlot.end - breakSlot.start } },
          });
        }
        sinceBreak = 0;
      }
    }

    // 5. Due recall cards get one bounded block (never an unbounded pile).
    const dueReviews = await learning.reviewsDueCount();
    if (dueReviews > 0 && remainingCapacity >= REVIEW_BLOCK_MINUTES) {
      const placement = findPlacement(freeWindows, placements, REVIEW_BLOCK_MINUTES, 'low', planning.buffer_minutes, []);
      if (placement) {
        placements.set('learning_reviews', placement);
        const reviewCards = Math.min(dueReviews, learningSettings.review_limit);
        slots.push({
          start: minutesToTime(placement.start), end: minutesToTime(placement.end), kind: 'task',
          title: `Spaced repetition (${reviewCards} cards due)`,
          note: 'active recall · short by design',
          generated_title: { code: 'spaced_repetition', params: { due: dueReviews, limit: reviewCards } },
          note_items: [{ code: 'active_recall' }],
        });
        remainingCapacity -= REVIEW_BLOCK_MINUTES;
      }
    }

    // 6. Protect free time explicitly (req. 34).
    const freeSlot = findPlacement(freeWindows, placements, protectedFree, 'low', 0, [], { preferLatest: true });
    if (freeSlot) {
      placements.set('free_time', freeSlot);
      slots.push({
        start: minutesToTime(freeSlot.start), end: minutesToTime(freeSlot.end), kind: 'free',
        title: 'Free time', note: 'protected — not a gap to fill',
        generated_title: { code: 'free_time', params: { minutes: freeSlot.end - freeSlot.start } },
        note_items: [{ code: 'free_time_note' }],
      });
    }

    // 7. Honest reporting.
    const demanded = scored.reduce((acc, s) => acc + s.minutes, 0);
    const overload = demanded > capacity + 30;
    if (overload) {
      warnings.push(`You asked for ${Math.round(demanded / 60 * 10) / 10}h of work but the day realistically holds ${Math.round(capacity / 60 * 10) / 10}h after ${Math.round(fixedMinutes / 60 * 10) / 10}h of fixed commitments. ${deferred.length} item(s) moved off today.`);
      warningItems.push({ code: 'overload', params: { demanded, capacity, fixed: fixedMinutes, deferred: deferred.length } });
    }
    if (fixedMinutes > (endBound - startBound) * 0.75) {
      warnings.push('This day is mostly fixed commitments. I kept the plan minimal on purpose.');
      warningItems.push({ code: 'fixed_heavy' });
    }
    if (!freeSlot && protectedFree > 0) {
      warnings.push('No room for protected free time today — consider moving something.');
      warningItems.push({ code: 'no_free_time' });
    }
    if (observedLoad !== null && capacity < demanded * 0.6) {
      warnings.push(`Based on the last weeks you complete ~${Math.round(observedLoad / 60 * 10) / 10}h of focused work a day; the plan stays near that.`);
      warningItems.push({ code: 'observed_load', params: { observed: observedLoad } });
    }

    slots.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
    const plan: DayPlan = {
      day,
      slots,
      deferred,
      focus_minutes: focusMinutes,
      free_minutes: freeSlot ? freeSlot.end - freeSlot.start : 0,
      fixed_minutes: fixedMinutes,
      capacity_minutes: capacity,
      overload,
      warnings,
      warning_items: warningItems,
      generated_at: nowIso(),
    };

    // Persist first, inside the repository's transaction, and hand back the plan exactly as it
    // was written: the deferred list stays truthful and every caller gets the same object, so
    // nobody needs to write it a second time (double-persisting used to raise a primary-key
    // error on `task_history` and abort the whole save).
    const persisted = options.dryRun && !options.persist ? plan : await this.persist(plan, day);
    this.log.info('day plan built', { day, slots: slots.length, deferred: deferred.length, capacity, focusMinutes, overload });
    return persisted;
  }

  /**
   * Adaptive rescheduling (req. 33): rebuild only what is left of today after a change
   * (lateness, new event, cancellation). Order: critical obligations → P0 → P1 → deadlines →
   * development → free time. Completed work is never touched.
   */
  async rebuildRemainingDay(now: Date = new Date(), reason?: string): Promise<DayPlan> {
    const day = dayKey(now);
    const { repos } = this.deps;
    // Release slots of tasks that were scheduled later today but have not started. Everything
    // else that follows belongs to the same logical operation, so it goes through one
    // transaction: a crash halfway through must not leave a half-released, half-re-planned day.
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return repos.db.runExclusive(() => repos.db.transaction(async () => {
      const todays = await repos.tasks.find({ scheduled_date: day, status: { op: 'in', value: ['scheduled', 'postponed', 'todo'] } }, { limit: 200 });
      for (const task of todays) {
        const start = task.scheduled_start ? timeToMinutes(task.scheduled_start) : null;
        if (start !== null && start >= nowMinutes) {
          await repos.tasks.update(task.id, { scheduled_start: null, scheduled_end: null, status: 'todo' } as never, { actor: 'system', reason: `schedule rebuilt${reason ? `: ${reason}` : ''}` });
        }
      }
      // `now` *and* `persist`: the rebuilt plan is written inside this transaction, so the returned
      // plan is the persisted one and callers must not persist it again.
      const plan = await this.buildDayNow(day, { now, dryRun: true, persist: true });
      if (reason) plan.warnings.unshift(`Rebuilt after: ${reason}`);
      return plan;
    }));
  }

  /** Write planned slots back onto tasks so they survive a restart and sync to other devices. */
  async persist(plan: DayPlan, day: string, ctx: WriteContext = USER_WRITE): Promise<DayPlan> {
    const { repos } = this.deps;
    const slots = [...plan.slots];
    const deferred = [...plan.deferred];
    await repos.db.transaction(async () => {
      for (const slot of plan.slots) {
        if (slot.kind !== 'task' || !slot.taskId) continue;
        const task = await repos.tasks.byId(slot.taskId);
        if (!task || task.status === 'done' || task.status === 'cancelled') continue;
        // The dashboard builds today's plan on every visit. Writing the same slot back would bump
        // `version`, stamp a new `updated_at` and queue a sync operation each time — which is both
        // noise in the change log and a real conflict hazard between two devices. An unchanged
        // slot is left exactly as it is.
        const unchanged = task.scheduled_date === day
          && task.scheduled_start === slot.start
          && task.scheduled_end === slot.end
          && task.status === 'scheduled';
        const next = unchanged ? task : await repos.tasks.update(slot.taskId, {
          scheduled_date: day,
          scheduled_start: slot.start,
          scheduled_end: slot.end,
          status: 'scheduled',
        } as never, { ...ctx, reason: 'scheduled by daily planner' });
        if (next && !unchanged) {
          // Keep the persisted plan honest: a slot whose task is no longer writable must not be
          // shown as work that was placed.
          const index = slots.findIndex((s) => s.taskId === slot.taskId);
          if (index >= 0) slots[index] = { ...slots[index], start: slot.start, end: slot.end };
          // One `scheduled` entry per task per day: rebuilding the schedule must never fail on a
          // duplicate primary key, and must never spam the history with identical rows.
          const historyId = `${slot.taskId}_${day}_planned`;
          const existing = await repos.taskHistory.byId(historyId);
          if (existing) {
            await repos.taskHistory.update(historyId, {
              from_status: task.status, to_status: 'scheduled', note: `planner: ${slot.start}–${slot.end}`, at: nowIso(),
            } as never);
          } else {
            await repos.taskHistory.insert({
              id: historyId, task_id: slot.taskId, action: 'scheduled',
              from_status: task.status, to_status: 'scheduled', reason: null,
              note: `planner: ${slot.start}–${slot.end}`, actor: ctx.actor, at: nowIso(), created_at: nowIso(),
            } as never);
          }
        }
      }
    });
    // Read back through the same planner so the UI, the AI context and the next restart all see
    // the schedule that is actually in the database (a task can be completed while we write).
    let stored = await this.snapshotFromDb(day, slots, deferred, plan);
    // `generated_at` moves on every call, so the cached plan is compared without it: when the
    // schedule, the totals and the warnings are identical, the plan that is already stored is
    // still the current one. The dashboard builds today's plan on every visit — rewriting the row
    // each time would also write a change-log entry each time.
    const cached = await repos.appState.byId('last_day_plan');
    const cachedAt = cached?.value ? planGeneratedAt(cached.value) : null;
    if (cachedAt && planEqualsIgnoringTimestamp(cached!.value, JSON.stringify(stored))) {
      stored = { ...stored, generated_at: cachedAt };
      return stored;
    }
    await repos.db.transaction(async () => {
      const value = JSON.stringify(stored);
      if (cached) await repos.appState.update('last_day_plan', { value, updated_at: nowIso() } as never);
      else await repos.appState.insert({ key: 'last_day_plan', value, updated_at: nowIso() } as never);
    });
    return stored;
  }

  /**
   * Read the schedule back out of the database for one day. This is what the UI, the AI context
   * and `planner.lastPlan()` show after a restart: the tasks that really carry a slot, not a
   * cached copy that may have drifted (a task completed on another device, a manual edit).
   */
  private async snapshotFromDb(day: string, slots: PlannedSlot[], deferred: DayPlan['deferred'], base: DayPlan): Promise<DayPlan> {
    const { repos } = this.deps;
    const tasks = await repos.tasks.find(
      { scheduled_date: day, status: { op: 'not_in', value: ['done', 'cancelled'] } },
      { orderBy: { scheduled_start: 'asc' }, limit: 500 },
    );
    const placed = tasks.filter((t) => t.scheduled_start && t.scheduled_end);
    const placedIds = new Set(placed.map((t) => t.id));
    const kept = slots.filter((s) => s.kind !== 'task' || !s.taskId || placedIds.has(s.taskId));
    for (const task of placed) {
      if (kept.some((s) => s.taskId === task.id)) continue;
      kept.push({
        start: task.scheduled_start!, end: task.scheduled_end!, kind: 'task', title: task.title,
        taskId: task.id, priority: task.priority, energy: task.energy,
      });
    }
    const focus = kept.filter((s) => s.kind === 'task').reduce((acc, s) => acc + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0);
    const free = kept.filter((s) => s.kind === 'free').reduce((acc, s) => acc + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0);
    return {
      ...base,
      slots: kept.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)),
      deferred: deferred.filter((d) => !placedIds.has(d.task_id)),
      focus_minutes: focus,
      free_minutes: free,
      generated_at: nowIso(),
    };
  }

  async lastPlan(): Promise<DayPlan | null> {
    const row = await this.deps.repos.appState.byId('last_day_plan');
    if (!row) return null;
    try { return JSON.parse(row.value) as DayPlan; } catch { return null; }
  }

  // ─────────────────────────── internals ───────────────────────────
  private async collectCandidates(day: string, options: PlannerOptions): Promise<Task[]> {
    const { repos, tasks, learning } = this.deps;
    const seen = new Set<string>();
    const out: Task[] = [];
    const push = (list: Task[]) => { for (const t of list) if (!seen.has(t.id) && t.status !== 'done' && t.status !== 'cancelled') { seen.add(t.id); out.push(t); } };

    push(await tasks.listForDay(day, { includeRecurring: true }));
    push(await tasks.overdue());
    const dueToday = await repos.tasks.find({ due_date: { op: 'lte', value: day }, status: { op: 'not_in', value: ['done', 'cancelled'] } }, { limit: 200 });
    push(dueToday);

    // Deadline-driven project work.
    const projects = await repos.projects.find({ status: 'active', deadline: { op: 'not_null' } }, { limit: 50 });
    for (const project of projects) {
      if (!project.deadline || daysUntil(project.deadline) > 14) continue;
      push(await repos.tasks.find({ project_id: project.id, status: { op: 'in', value: ['todo', 'in_progress', 'postponed'] } }, { limit: 30 }));
    }

    // Learning topics that are ready.
    const nextActions = await learning.nextActions(4);
    for (const action of nextActions) {
      if (action.kind !== 'topic') continue;
      push(await repos.tasks.find({ learning_topic_id: action.topic_id, status: { op: 'not_in', value: ['done', 'cancelled'] } }, { limit: 10 }));
    }

    // Goal-aligned backlog.
    const activeGoals = await repos.goals.find({ status: 'active' }, { limit: 50 });
    for (const goal of activeGoals.slice(0, 6)) {
      push(await repos.tasks.find({ goal_id: goal.id, scheduled_date: null, status: { op: 'in', value: ['todo', 'postponed'] } }, { limit: 10 }));
    }
    push(await tasks.backlog(40));
    if (options.extraCandidates) push(options.extraCandidates);
    return out;
  }

  private score(candidates: Task[], ctx: { day: string; planning: { strictness: number }; now: Date; personalizationBest: number[] }): ScoredTask[] {
    const scored: ScoredTask[] = [];

    for (const task of candidates) {
      const reasons: string[] = [];
      const reasonItems: PlanNote[] = [];
      const priorityWeight = PRIORITY_WEIGHT[task.priority as Priority] ?? 0.45;

      // urgency: due date proximity
      let urgency = 0;
      if (task.due_date) {
        const days = daysUntil(task.due_date, ctx.now);
        if (days < 0) { urgency = 1; reasons.push(`overdue by ${Math.abs(days)}d`); reasonItems.push({ code: 'overdue_by', params: { days: Math.abs(days) } }); }
        else if (days === 0) { urgency = 0.95; reasons.push('due today'); reasonItems.push({ code: 'due_today' }); }
        else if (days <= 2) { urgency = 0.7; reasons.push(`due in ${days}d`); reasonItems.push({ code: 'due_in', params: { days } }); }
        else if (days <= 7) { urgency = 0.4; reasons.push(`due in ${days}d`); reasonItems.push({ code: 'due_in', params: { days } }); }
        else urgency = 0.15;
      }

      // importance: priority + strict flag + postponement history
      let importance = priorityWeight;
      if (task.strict === 1) { importance = Math.min(1, importance + 0.2); reasons.push('marked important'); reasonItems.push({ code: 'marked_important' }); }
      if (Number(task.postponed_count) >= 2) { importance = Math.min(1, importance + 0.1); reasons.push(`postponed ${task.postponed_count}×`); reasonItems.push({ code: 'postponed_n', params: { count: Number(task.postponed_count) } }); }

      // goal alignment
      const goalAlignment = task.goal_id ? 0.8 : task.project_id ? 0.6 : task.learning_topic_id ? 0.55 : 0.25;
      if (task.goal_id) { reasons.push('serves a goal'); reasonItems.push({ code: 'serves_goal' }); }

      // skill value: learning/practice builds capability
      const skillValue = task.kind === 'learning' || task.kind === 'practice' || task.kind === 'review' ? 0.7 : task.kind === 'project' ? 0.55 : 0.3;

      // energy fit with the user's observed best hours
      const best = ctx.personalizationBest;
      const energyFit = best.length ? (best.some((h) => Math.abs(h - ctx.now.getHours()) <= 3) ? 0.7 : 0.4) : 0.5;

      // momentum: small tasks first when the day is fragmented
      const momentum = task.estimated_minutes <= 25 ? 0.6 : 0.3;

      const score = Number((
        0.3 * importance + 0.22 * urgency + 0.18 * goalAlignment + 0.12 * (task.due_date ? urgency : 0.3)
        + 0.08 * skillValue + 0.05 * energyFit + 0.05 * momentum
      ).toFixed(4));

      const preferredHours = task.energy === 'high' ? (best.length ? best : [9, 10, 11]) : task.energy === 'low' ? [15, 16, 20, 21] : [];
      scored.push({ task, score, reasons, reason_items: reasonItems, minutes: Math.max(10, Math.round(Number(task.estimated_minutes ?? 30))), preferredHours });
    }

    return scored.sort((a, b) => b.score - a.score || (a.task.priority as string).localeCompare(b.task.priority as string));
  }

  /** Human-readable explanation of the plan (shown in Today and used by the mentor). */
  explain(plan: DayPlan): string {
    const lines: string[] = [];
    const tasks = plan.slots.filter((s) => s.kind === 'task');
    lines.push(`${plan.day}: ${Math.round(plan.fixed_minutes / 60 * 10) / 10}h fixed, ${Math.round(plan.focus_minutes / 60 * 10) / 10}h planned focus, ${Math.round(plan.free_minutes / 60 * 10) / 10}h protected free time.`);
    if (tasks.length) lines.push(`Focus: ${tasks.map((t) => `${t.start} ${t.title}`).join('; ')}.`);
    if (plan.deferred.length) lines.push(`Not today: ${plan.deferred.map((d) => `${d.title} (${d.reason})`).join('; ')}.`);
    for (const warning of plan.warnings) lines.push(warning);
    return lines.join('\n');
  }
}

// ─────────────────────────── pure helpers (unit-tested) ───────────────────────────
interface Span { start: number; end: number }

export function mergeMinutes(spans: Span[]): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -1;
  for (const span of sorted) {
    const start = Math.max(span.start, cursor);
    if (span.end > start) total += span.end - start;
    cursor = Math.max(cursor, span.end);
  }
  return total;
}

/** Gaps between busy blocks, inside [from, to], at least 15 minutes wide. */
export function windowsBetween(blocks: BusyBlock[], from: number, to: number, buffer: number): Span[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const windows: Span[] = [];
  let cursor = from;
  for (const block of sorted) {
    const start = Math.max(block.start, from);
    const end = Math.min(block.end, to);
    if (end <= start) continue;
    if (start - cursor >= 15) windows.push({ start: cursor + (windows.length ? 0 : 0), end: start - buffer });
    cursor = Math.max(cursor, end + buffer);
  }
  if (to - cursor >= 15) windows.push({ start: cursor, end: to });
  return windows.filter((w) => w.end - w.start >= 15);
}

function clampMinutes(value: number): number { return Math.max(0, Math.min(24 * 60, Math.round(value))); }

/**
 * Find a free slot for `minutes` that does not overlap an existing placement.
 * Energy-aware: high-energy work prefers the user's best hours; `preferLatest` is used to
 * push protected free time to the end of the day.
 */
export function findPlacement(
  windows: Span[],
  placements: Map<string, Span>,
  minutes: number,
  energy: Energy,
  buffer: number,
  preferredHours: number[],
  options: { preferLatest?: boolean } = {},
): Span | null {
  const taken = [...placements.values()].sort((a, b) => a.start - b.start);
  const candidates: Span[] = [];
  for (const window of windows) {
    let cursor = window.start;
    for (const slot of taken) {
      if (slot.end <= cursor || slot.start >= window.end) continue;
      if (slot.start - cursor >= minutes) candidates.push({ start: cursor, end: cursor + minutes });
      cursor = Math.max(cursor, slot.end + buffer);
    }
    if (window.end - cursor >= minutes) candidates.push({ start: cursor, end: cursor + minutes });
  }
  if (!candidates.length) return null;
  if (options.preferLatest) return candidates[candidates.length - 1];
  const scored = candidates.map((span) => {
    const hour = Math.floor(span.start / 60);
    let score = 0;
    if (preferredHours.includes(hour)) score += 2;
    if (energy === 'high' && hour >= 8 && hour <= 12) score += 1;
    if (energy === 'low' && hour >= 14) score += 0.75;
    score -= span.start / 1440; // prefer earlier, all else equal
    return { span, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].span;
}

/** Safety net used by tests and by the UI: a plan must never overlap a critical event. */
export function assertNoCriticalOverlap(plan: DayPlan, criticalBlocks: BusyBlock[]): string[] {
  const violations: string[] = [];
  for (const slot of plan.slots) {
    if (slot.kind === 'event') continue;
    const s = timeToMinutes(slot.start);
    const e = timeToMinutes(slot.end);
    for (const block of criticalBlocks) {
      if (s < block.end && e > block.start) violations.push(`"${slot.title}" (${slot.start}–${slot.end}) overlaps "${block.title}" (${minutesToTime(block.start)}–${minutesToTime(block.end)})`);
    }
  }
  return violations;
}
