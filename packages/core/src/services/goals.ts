import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { Goal, GoalMetric, GoalStatus, Horizon, Priority } from '../domain/types';
import { newId } from '../util/id';
import { addDays, dayKey, daysUntil, nowIso } from '../util/time';
import { AppError } from '../util/result';

export const CreateGoalSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullish(),
  area: z.string().trim().max(80).nullish(),
  horizon: z.enum(['long', 'medium', 'short', 'daily']).default('medium'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  parent_id: z.string().nullish(),
  motivation: z.string().trim().max(1000).nullish(),
  metric: z.object({ kind: z.enum(['number', 'boolean', 'habit']), target: z.number().optional(), current: z.number().optional(), unit: z.string().optional() }).nullish(),
  start_date: z.string().nullish(),
  target_date: z.string().nullish(),
  strict: z.boolean().default(false),
});
export type CreateGoalInput = z.input<typeof CreateGoalSchema>;

export const UpdateGoalSchema = CreateGoalSchema.partial().extend({
  status: z.enum(['active', 'paused', 'achieved', 'abandoned', 'archived']).optional(),
  progress: z.number().min(0).max(100).optional(),
});
export type UpdateGoalInput = z.input<typeof UpdateGoalSchema>;

/** Fields whose change is recorded in the immutable `strategy_changes` history (req. 81). */
const TRACKED_FIELDS: (keyof Goal)[] = ['title', 'horizon', 'status', 'priority', 'target_date', 'parent_id', 'description'];

export interface GoalNode extends Goal {
  children: GoalNode[];
  task_stats: { total: number; done: number };
  project_count: number;
  days_left: number | null;
}

export class GoalService {
  constructor(private readonly repos: Repos) {}

  async create(input: CreateGoalInput, ctx: WriteContext = USER_WRITE): Promise<Goal> {
    const parsed = CreateGoalSchema.parse(input);
    if (parsed.parent_id) {
      const parent = await this.repos.goals.byId(parsed.parent_id);
      if (!parent) throw AppError.notFound('goal', parsed.parent_id);
      if (parent.horizon === 'daily' && parsed.horizon !== 'daily') {
        throw AppError.validation('A daily goal cannot contain a longer-horizon goal.');
      }
    }
    const goal = await this.repos.goals.insert({
      id: newId('goal'),
      title: parsed.title,
      description: parsed.description ?? null,
      area: parsed.area ?? null,
      horizon: parsed.horizon,
      status: 'active',
      priority: parsed.priority,
      parent_id: parsed.parent_id ?? null,
      motivation: parsed.motivation ?? null,
      metric_json: parsed.metric ? JSON.stringify(parsed.metric) : null,
      progress: 0,
      start_date: parsed.start_date ?? dayKey(),
      target_date: parsed.target_date ?? null,
      completed_at: null,
      archived_at: null,
      strict: parsed.strict ? 1 : 0,
    } as never, { ...ctx, reason: 'goal created' });

    await this.repos.strategyChanges.insert({
      id: newId(), entity_type: 'goal', entity_id: goal.id, field: 'title', old_value: null,
      new_value: goal.title, reason: 'goal created', actor: ctx.actor, created_at: nowIso(),
    } as never);
    return goal;
  }

  async update(id: string, patch: UpdateGoalInput, ctx: WriteContext = USER_WRITE): Promise<Goal> {
    const before = await this.repos.goals.byId(id);
    if (!before) throw AppError.notFound('goal', id);
    const parsed = UpdateGoalSchema.parse(patch);
    if (parsed.parent_id === id) throw AppError.validation('A goal cannot be its own parent.');

    const record: Record<string, unknown> = {};
    if (parsed.title !== undefined) record.title = parsed.title;
    if (parsed.description !== undefined) record.description = parsed.description ?? null;
    if (parsed.area !== undefined) record.area = parsed.area ?? null;
    if (parsed.horizon !== undefined) record.horizon = parsed.horizon;
    if (parsed.priority !== undefined) record.priority = parsed.priority;
    if (parsed.parent_id !== undefined) record.parent_id = parsed.parent_id ?? null;
    if (parsed.motivation !== undefined) record.motivation = parsed.motivation ?? null;
    if (parsed.metric !== undefined) record.metric_json = parsed.metric ? JSON.stringify(parsed.metric) : null;
    if (parsed.start_date !== undefined) record.start_date = parsed.start_date ?? null;
    if (parsed.target_date !== undefined) record.target_date = parsed.target_date ?? null;
    if (parsed.progress !== undefined) record.progress = Math.max(0, Math.min(100, parsed.progress));
    if (parsed.strict !== undefined) record.strict = parsed.strict ? 1 : 0;
    if (parsed.status !== undefined) {
      record.status = parsed.status;
      if (parsed.status === 'achieved' && !before.completed_at) record.completed_at = nowIso();
      if (parsed.status === 'archived' && !before.archived_at) record.archived_at = nowIso();
      if (parsed.status === 'active') { record.completed_at = null; record.archived_at = null; }
    }

    const updated = await this.repos.goals.update(id, record as never, { ...ctx, reason: ctx.reason ?? 'goal updated' });
    if (!updated) throw AppError.notFound('goal', id);

    for (const field of TRACKED_FIELDS) {
      const oldValue = before[field];
      const newValue = updated[field];
      if (String(oldValue ?? '') !== String(newValue ?? '')) {
        await this.repos.strategyChanges.insert({
          id: newId(), entity_type: 'goal', entity_id: id, field: String(field),
          old_value: oldValue === null || oldValue === undefined ? null : String(oldValue),
          new_value: newValue === null || newValue === undefined ? null : String(newValue),
          reason: ctx.reason ?? 'goal updated', actor: ctx.actor, created_at: nowIso(),
        } as never);
      }
    }
    return updated;
  }

  async get(id: string): Promise<Goal | null> { return (await this.repos.goals.byId(id)) ?? null; }

  async list(filter: { status?: GoalStatus | GoalStatus[]; horizon?: Horizon; includeArchived?: boolean } = {}): Promise<Goal[]> {
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status;
    else if (!filter.includeArchived) where.status = { op: 'not_in', value: ['archived', 'abandoned'] };
    if (filter.horizon) where.horizon = filter.horizon;
    return this.repos.goals.find(where as never, { orderBy: { priority: 'asc', updated_at: 'desc' }, limit: 500 });
  }

  async tree(): Promise<GoalNode[]> {
    const goals = await this.list({ includeArchived: false });
    const nodes = new Map<string, GoalNode>();
    for (const g of goals) {
      const tasks = await this.repos.tasks.find({ goal_id: g.id }, { limit: 1000 });
      nodes.set(g.id, {
        ...g,
        children: [],
        task_stats: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length },
        project_count: await this.repos.projects.count({ goal_id: g.id }),
        days_left: g.target_date ? daysUntil(g.target_date) : null,
      });
    }
    const roots: GoalNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return roots;
  }

  async link(parentId: string, childId: string, relation: 'supports' | 'requires' | 'conflicts_with' = 'supports', note?: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    if (parentId === childId) throw AppError.validation('Cannot link a goal to itself.');
    const existing = await this.repos.goalRelationships.findOne({ parent_goal_id: parentId, child_goal_id: childId, relation_type: relation });
    if (existing) return;
    await this.repos.goalRelationships.insert({
      id: newId(), parent_goal_id: parentId, child_goal_id: childId, relation_type: relation, note: note ?? null, created_at: nowIso(),
    } as never, ctx);
    if (relation === 'supports' || relation === 'requires') {
      await this.update(childId, { parent_id: parentId }, { ...ctx, reason: `goal linked (${relation})` });
    }
  }

  async unlink(parentId: string, childId: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    const rel = await this.repos.goalRelationships.findOne({ parent_goal_id: parentId, child_goal_id: childId });
    if (rel) await this.repos.goalRelationships.hardDelete(rel.id, ctx);
  }

  async archive(id: string, reason = 'archived by user', ctx: WriteContext = USER_WRITE): Promise<Goal> {
    return this.update(id, { status: 'archived' }, { ...ctx, reason });
  }

  async complete(id: string, ctx: WriteContext = USER_WRITE): Promise<Goal> {
    return this.update(id, { status: 'achieved', progress: 100 }, { ...ctx, reason: 'goal achieved' });
  }

  /**
   * Progress rolls up from real evidence, never from a guess:
   * metric → child goals → linked projects → linked tasks.
   */
  async recomputeProgress(id: string, ctx: WriteContext = USER_WRITE): Promise<number> {
    const goal = await this.repos.goals.byId(id);
    if (!goal) throw AppError.notFound('goal', id);

    const metric: GoalMetric | null = goal.metric_json ? (JSON.parse(goal.metric_json) as GoalMetric) : null;
    let progress: number | null = null;

    if (metric?.kind === 'number' && metric.target) {
      progress = Math.max(0, Math.min(100, ((metric.current ?? 0) / metric.target) * 100));
    } else if (metric?.kind === 'boolean') {
      progress = (metric.current ?? 0) >= 1 ? 100 : 0;
    }

    if (progress === null) {
      const children = await this.repos.goals.find({ parent_id: id }, { limit: 200 });
      if (children.length) {
        progress = children.reduce((acc, c) => acc + Number(c.progress ?? 0), 0) / children.length;
      }
    }

    if (progress === null) {
      const projects = await this.repos.projects.find({ goal_id: id }, { limit: 100 });
      if (projects.length) progress = projects.reduce((acc, p) => acc + Number(p.progress ?? 0), 0) / projects.length;
    }

    if (progress === null) {
      const tasks = await this.repos.tasks.find({ goal_id: id }, { limit: 1000 });
      if (tasks.length) {
        const done = tasks.filter((t) => t.status === 'done');
        const weight = (t: (typeof tasks)[number]) => Math.max(5, Number(t.estimated_minutes ?? 30));
        const totalWeight = tasks.reduce((acc, t) => acc + weight(t), 0);
        const doneWeight = done.reduce((acc, t) => acc + weight(t), 0);
        progress = totalWeight > 0 ? (doneWeight / totalWeight) * 100 : 0;
      }
    }

    const value = Math.round(Math.max(0, Math.min(100, progress ?? Number(goal.progress ?? 0))));
    if (value !== Number(goal.progress)) {
      await this.repos.goals.update(id, { progress: value } as never, { ...ctx, reason: 'progress recomputed from evidence', audit: value !== Number(goal.progress) });
    }
    return value;
  }

  /**
   * Goal review (req. 37): staleness, progress, inactivity, conflicts, realism.
   * Produces findings + a recommendation; applying a status change is explicit.
   */
  async review(id: string, options: { findings?: unknown; recommendation?: string; decision?: 'keep' | 'adjust' | 'pause' | 'archive' | 'split'; applyDecision?: boolean } = {}, ctx: WriteContext = USER_WRITE): Promise<Goal> {
    const goal = await this.repos.goals.byId(id);
    if (!goal) throw AppError.notFound('goal', id);
    const tasks = await this.repos.tasks.find({ goal_id: id }, { limit: 1000 });
    const lastActivity = tasks.map((t) => t.updated_at).sort().pop() ?? goal.updated_at;
    const inactiveDays = Math.abs(daysUntil(lastActivity));
    const findings = {
      progress: Number(goal.progress ?? 0),
      tasks_total: tasks.length,
      tasks_done: tasks.filter((t) => t.status === 'done').length,
      tasks_overdue: tasks.filter((t) => t.due_date && t.status !== 'done' && t.status !== 'cancelled' && daysUntil(t.due_date) < 0).length,
      inactive_days: inactiveDays,
      has_target_date: Boolean(goal.target_date),
      days_left: goal.target_date ? daysUntil(goal.target_date) : null,
      ...(typeof options.findings === 'object' && options.findings ? options.findings as Record<string, unknown> : {}),
    };
    await this.repos.goalReviews.insert({
      id: newId(), goal_id: id, reviewed_at: nowIso(), findings_json: JSON.stringify(findings),
      recommendation: options.recommendation ?? null, decision: options.decision ?? null,
      status_before: goal.status, status_after: options.applyDecision && options.decision ? decisionToStatus(options.decision, goal.status) : goal.status,
      created_at: nowIso(),
    } as never, ctx);

    if (options.applyDecision && options.decision) {
      const status = decisionToStatus(options.decision, goal.status);
      if (status !== goal.status) return this.update(id, { status }, { ...ctx, reason: `goal review decision: ${options.decision}` });
    }
    return goal;
  }

  /** Detect goals that pull in opposite directions (req. 37). */
  async detectConflicts(): Promise<{ a: Goal; b: Goal; reason: string }[]> {
    const relations = await this.repos.goalRelationships.find({ relation_type: 'conflicts_with' }, { limit: 200 });
    const out: { a: Goal; b: Goal; reason: string }[] = [];
    for (const rel of relations) {
      const [a, b] = await Promise.all([this.repos.goals.byId(rel.parent_goal_id), this.repos.goals.byId(rel.child_goal_id)]);
      if (a && b) out.push({ a, b, reason: rel.note ?? 'Marked as conflicting' });
    }
    // Time-overload conflict: too many active goals with the same near deadline.
    const active = await this.list({ status: 'active' });
    const byDeadline = new Map<string, Goal[]>();
    for (const g of active) {
      if (!g.target_date) continue;
      const bucket = dayKey(g.target_date);
      byDeadline.set(bucket, [...(byDeadline.get(bucket) ?? []), g]);
    }
    for (const [date, goals] of byDeadline) {
      if (goals.length >= 3) {
        for (let i = 1; i < goals.length; i++) {
          out.push({ a: goals[0], b: goals[i], reason: `${goals.length} active goals target the same date (${date}) — capacity conflict` });
        }
      }
    }
    return out;
  }

  /** Goals that got no attention for a while — surfaced in reviews and the dashboard. */
  async stale(days = 14): Promise<Goal[]> {
    const cutoff = addDays(new Date(), -days).toISOString();
    const active = await this.list({ status: 'active' });
    const stale: Goal[] = [];
    for (const goal of active) {
      const recentTasks = await this.repos.tasks.count({ goal_id: goal.id, updated_at: { op: 'gte', value: cutoff } });
      if (recentTasks === 0 && goal.updated_at < cutoff) stale.push(goal);
    }
    return stale;
  }

  /** Compact rendering for the AI context engine (req. 25). */
  async contextText(limit = 6): Promise<string> {
    const goals = await this.list({ status: 'active' });
    const ordered = goals.sort((a, b) => a.priority.localeCompare(b.priority) || Number(b.progress) - Number(a.progress)).slice(0, limit);
    return ordered.map((g) => {
      const deadline = g.target_date ? ` (target ${g.target_date}${daysUntil(g.target_date) <= 7 ? `, ${daysUntil(g.target_date)}d left` : ''})` : '';
      return `- [${g.horizon}/${g.priority}] ${g.title}${deadline} — ${Math.round(Number(g.progress))}%`;
    }).join('\n');
  }
}

type ReviewDecision = 'keep' | 'adjust' | 'pause' | 'archive' | 'split';

function decisionToStatus(decision: ReviewDecision, current: GoalStatus): GoalStatus {
  switch (decision) {
    case 'pause': return 'paused';
    case 'archive': return 'archived';
    case 'keep': return current === 'paused' ? 'active' : current;
    case 'adjust': case 'split': return 'active';
    default: return current;
  }
}

export type { Priority };
