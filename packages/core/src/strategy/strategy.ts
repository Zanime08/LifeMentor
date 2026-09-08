import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { StrategyChange, StrategyHorizon, StrategyItem, Task } from '../domain/types';
import type { GoalService } from '../services/goals';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';

export const HORIZONS: StrategyHorizon[] = ['3-5y', '1y', '3mo', '1mo', '1w', 'today', 'now'];
export const HORIZON_PARENT: Record<StrategyHorizon, StrategyHorizon | null> = {
  '3-5y': null, '1y': '3-5y', '3mo': '1y', '1mo': '3mo', '1w': '1mo', today: '1w', now: 'today',
};

export const StrategyItemInput = z.object({
  horizon: z.enum(HORIZONS as [StrategyHorizon, ...StrategyHorizon[]]),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  goal_id: z.string().nullish(),
  status: z.enum(['active', 'done', 'dropped']).default('active'),
  position: z.number().int().min(0).default(0),
  review_at: z.string().nullish(),
});

/** One possible future (req. 46). Values are user/AI-supplied estimates, never promises. */
export const OptionInput = z.object({
  id: z.string().nullish(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['career', 'freelance', 'business', 'digital_product', 'investment', 'education', 'other']).default('career'),
  /** 1 (safe) .. 5 (very risky) — as judged with the user, not by the system. */
  risk: z.number().min(1).max(5).default(3),
  required_knowledge: z.array(z.string().max(120)).max(20).default([]),
  hours_per_week: z.number().min(0).max(80).default(10),
  capital_required: z.number().min(0).default(0),
  months_to_first_result: z.number().min(0).max(120).default(12),
  /** Labelled estimate, never a promise. */
  income_estimate: z.string().max(120).nullish(),
  complexity: z.number().min(1).max(5).default(3),
  /** How easy it is to undo / exit. */
  reversibility: z.number().min(1).max(5).default(3),
  notes: z.string().max(1000).nullish(),
});
export type OptionInput = z.input<typeof OptionInput>;

export interface OptionComparison {
  options: z.infer<typeof OptionInput>[];
  ranking: { name: string; fit_score: number; why: string }[];
  caveats: string[];
}

/**
 * Strategy engine (req. 79, 80, 81, 45, 46).
 *
 * Horizons are linked: 3-5y → 1y → 3mo → 1mo → 1w → today → now. Every change of direction is
 * written to `strategy_changes` (old value, new value, reason, date) — an immutable history of
 * how the user evolved. Nothing is overwritten silently.
 */
export class StrategyService {
  constructor(private readonly repos: Repos, private readonly goals: GoalService) {}

  async list(horizon?: StrategyHorizon): Promise<StrategyItem[]> {
    return this.repos.strategyItems.find(horizon ? { horizon, status: { op: 'in', value: ['active', 'done'] } } : {}, { orderBy: { position: 'asc', updated_at: 'desc' }, limit: 300 });
  }

  async addItem(input: z.input<typeof StrategyItemInput>, ctx: WriteContext = USER_WRITE): Promise<StrategyItem> {
    const parsed = StrategyItemInput.parse(input);
    if (parsed.goal_id && !(await this.repos.goals.byId(parsed.goal_id))) throw AppError.notFound('goal', parsed.goal_id);
    const item = await this.repos.strategyItems.insert({
      id: newId('strategy'), horizon: parsed.horizon, title: parsed.title, description: parsed.description ?? null,
      goal_id: parsed.goal_id ?? null, status: parsed.status, position: parsed.position, review_at: parsed.review_at ?? null,
    } as never, { ...ctx, reason: `strategy item added (${parsed.horizon})` });
    await this.recordChange('strategy_item', item.id, 'title', null, item.title, ctx.reason ?? 'strategy item added', ctx.actor);
    return item;
  }

  async updateItem(id: string, patch: Partial<{ title: string; description: string | null; goal_id: string | null; status: StrategyItem['status']; position: number; review_at: string | null }>, ctx: WriteContext = USER_WRITE): Promise<StrategyItem> {
    const before = await this.repos.strategyItems.byId(id);
    if (!before) throw AppError.notFound('strategy item', id);
    const updated = await this.repos.strategyItems.update(id, patch as never, { ...ctx, reason: ctx.reason ?? 'strategy item updated' });
    if (!updated) throw AppError.notFound('strategy item', id);
    for (const field of ['title', 'status', 'goal_id', 'description'] as const) {
      if (patch[field] !== undefined && String(before[field] ?? '') !== String(patch[field] ?? '')) {
        await this.recordChange('strategy_item', id, field, String(before[field] ?? ''), String(patch[field] ?? ''), ctx.reason ?? 'strategy item updated', ctx.actor);
      }
    }
    return updated;
  }

  async drop(id: string, reason: string, ctx: WriteContext = USER_WRITE): Promise<StrategyItem> {
    const before = await this.repos.strategyItems.byId(id);
    if (!before) throw AppError.notFound('strategy item', id);
    const updated = await this.updateItem(id, { status: 'dropped' }, { ...ctx, reason });
    await this.recordChange('strategy_item', id, 'status', before.status, 'dropped', reason, ctx.actor);
    return updated;
  }

  /** Replace a horizon's items, preserving history for everything removed or changed. */
  async setHorizon(horizon: StrategyHorizon, items: { title: string; description?: string | null; goal_id?: string | null }[], reason: string, ctx: WriteContext = USER_WRITE): Promise<StrategyItem[]> {
    const existing = await this.repos.strategyItems.find({ horizon, status: 'active' }, { limit: 100 });
    const keepTitles = new Set(items.map((i) => i.title.trim().toLowerCase()));
    for (const item of existing) {
      if (!keepTitles.has(item.title.trim().toLowerCase())) await this.drop(item.id, `${reason} (removed during ${horizon} revision)`, ctx);
    }
    const out: StrategyItem[] = [];
    let position = 0;
    for (const item of items) {
      const match = existing.find((e) => e.title.trim().toLowerCase() === item.title.trim().toLowerCase());
      if (match) { out.push(await this.updateItem(match.id, { position: position++, description: item.description ?? match.description }, ctx)); continue; }
      out.push(await this.addItem({ horizon, title: item.title, description: item.description ?? null, goal_id: item.goal_id ?? null, position: position++ }, { ...ctx, reason }));
    }
    return out;
  }

  /** Derive the horizon ladder from the user's goals (long → medium → short → today). */
  async buildFromGoals(reason = 'generated from confirmed goals', ctx: WriteContext = USER_WRITE): Promise<Record<StrategyHorizon, StrategyItem[]>> {
    const goals = await this.goals.list({ status: 'active' });
    const byHorizon: Record<string, typeof goals> = { long: [], medium: [], short: [], daily: [] };
    for (const goal of goals) (byHorizon[goal.horizon] ??= []).push(goal);

    const result = {} as Record<StrategyHorizon, StrategyItem[]>;
    const mapping: [StrategyHorizon, string][] = [['3-5y', 'long'], ['1y', 'long'], ['3mo', 'medium'], ['1mo', 'medium'], ['1w', 'short'], ['today', 'daily'], ['now', 'daily']];
    for (const [horizon, goalHorizon] of mapping) {
      const source = byHorizon[goalHorizon] ?? [];
      const items = source.slice(0, horizon === 'now' || horizon === 'today' ? 3 : 5).map((g) => ({
        title: g.title,
        description: g.description,
        goal_id: g.id,
      }));
      result[horizon] = items.length ? await this.setHorizon(horizon, items, reason, ctx) : await this.list(horizon);
    }
    return result;
  }

  /** Trace a task up to the life direction it serves ("why am I doing this?"). */
  async traceUp(taskId: string): Promise<{ level: string; title: string; id?: string }[]> {
    const chain: { level: string; title: string; id?: string }[] = [];
    const task = await this.repos.tasks.byId(taskId);
    if (!task) throw AppError.notFound('task', taskId);
    chain.push({ level: 'now', title: task.title, id: task.id });

    let goalId = task.goal_id;
    if (task.project_id) {
      const project = await this.repos.projects.byId(task.project_id);
      if (project) {
        chain.push({ level: 'project', title: project.title, id: project.id });
        goalId = goalId ?? project.goal_id;
      }
    }
    if (task.learning_topic_id) {
      const topic = await this.repos.learningTopics.byId(task.learning_topic_id);
      if (topic) chain.push({ level: 'learning', title: topic.title, id: topic.id });
    }
    const seen = new Set<string>();
    while (goalId && !seen.has(goalId)) {
      seen.add(goalId);
      const goal = await this.repos.goals.byId(goalId);
      if (!goal) break;
      chain.push({ level: `goal:${goal.horizon}`, title: goal.title, id: goal.id });
      const strategy = await this.repos.strategyItems.findOne({ goal_id: goal.id, status: 'active' }, { orderBy: { position: 'asc' } });
      if (strategy) chain.push({ level: `strategy:${strategy.horizon}`, title: strategy.title, id: strategy.id });
      goalId = goal.parent_id;
    }
    return chain;
  }

  /** Check the ladder is coherent: every horizon should point at something real. */
  async audit(): Promise<{ horizon: StrategyHorizon; items: number; unlinked: number; warnings: string[] }[]> {
    const out: { horizon: StrategyHorizon; items: number; unlinked: number; warnings: string[] }[] = [];
    for (const horizon of HORIZONS) {
      const items = await this.repos.strategyItems.find({ horizon, status: 'active' }, { limit: 100 });
      const unlinked = items.filter((i) => !i.goal_id).length;
      const warnings: string[] = [];
      if (!items.length) warnings.push(`No active ${horizon} direction.`);
      if (unlinked === items.length && items.length > 0) warnings.push('None of these are linked to a goal — they cannot be traced to today\'s actions.');
      const parentHorizon = HORIZON_PARENT[horizon];
      if (parentHorizon) {
        const parentItems = await this.repos.strategyItems.find({ horizon: parentHorizon, status: 'active' }, { limit: 100 });
        if (!parentItems.length && items.length) warnings.push(`These ${horizon} items have no ${parentHorizon} direction above them.`);
      }
      out.push({ horizon, items: items.length, unlinked, warnings });
    }
    return out;
  }

  /**
   * Option building (req. 45, 46): compare several possible futures on risk, knowledge, time,
   * capital, income estimate, complexity and reversibility. The system does NOT claim any option
   * is objectively better and never promises income.
   */
  compareOptions(rawOptions: OptionInput[], context: { hours_per_week_available?: number; capital_available?: number; risk_tolerance?: number; horizon_months?: number } = {}): OptionComparison {
    const options = rawOptions.map((o) => OptionInput.parse(o));
    if (!options.length) return { options: [], ranking: [], caveats: ['No options provided.'] };

    const ranking = options.map((option) => {
      const why: string[] = [];
      let fit = 0;
      const timeFit = context.hours_per_week_available ? Math.min(1, context.hours_per_week_available / Math.max(1, option.hours_per_week)) : 0.6;
      const capitalFit = context.capital_available !== undefined ? (option.capital_required <= context.capital_available ? 1 : Math.max(0, context.capital_available / Math.max(1, option.capital_required))) : 0.6;
      const riskFit = context.risk_tolerance ? 1 - Math.abs(option.risk - context.risk_tolerance) / 4 : 0.5;
      const speedFit = context.horizon_months ? Math.min(1, context.horizon_months / Math.max(1, option.months_to_first_result)) : 0.5;

      fit = 0.3 * timeFit + 0.25 * capitalFit + 0.25 * riskFit + 0.2 * speedFit;
      if (timeFit < 0.6) why.push(`needs ${option.hours_per_week}h/week — more than you have`);
      if (capitalFit < 0.6) why.push(`needs capital you do not have yet (${option.capital_required})`);
      if (riskFit < 0.5) why.push(option.risk > (context.risk_tolerance ?? 3) ? 'riskier than you said you want' : 'safer than you asked for — possibly slower');
      if (speedFit < 0.5) why.push(`first result in ~${option.months_to_first_result} months, beyond your horizon`);
      if (option.reversibility >= 4) why.push('easy to reverse — cheap to try');
      if (!why.length) why.push('fits your current time, capital and risk tolerance');
      return { name: option.name, fit_score: Number(fit.toFixed(2)), why: why.join('; ') };
    }).sort((a, b) => b.fit_score - a.fit_score);

    const caveats = [
      'Fit scores compare options against YOUR stated constraints — they are not a prediction of success.',
      'Income figures are estimates supplied in the option data, not promises or financial advice.',
      'Options are not mutually exclusive: several can be run in parallel at low cost if time allows.',
      'Re-check this comparison whenever your available time, capital or risk tolerance changes.',
    ];
    return { options, ranking, caveats };
  }

  async recordChange(entityType: string, entityId: string, field: string | null, oldValue: string | null, newValue: string | null, reason: string, actor: StrategyChange['actor'] = 'user'): Promise<void> {
    await this.repos.strategyChanges.insert({
      id: newId(), entity_type: entityType, entity_id: entityId, field, old_value: oldValue, new_value: newValue,
      reason, actor, created_at: nowIso(),
    } as never);
  }

  async changes(filter: { entityType?: string; entityId?: string; limit?: number } = {}): Promise<StrategyChange[]> {
    const where: Record<string, unknown> = {};
    if (filter.entityType) where.entity_type = filter.entityType;
    if (filter.entityId) where.entity_id = filter.entityId;
    return this.repos.strategyChanges.find(where as never, { orderBy: { created_at: 'desc' }, limit: filter.limit ?? 100 });
  }

  /** Full ladder for the Profile / Strategy screen and for AI context. */
  async ladder(): Promise<{ horizon: StrategyHorizon; items: StrategyItem[] }[]> {
    const out: { horizon: StrategyHorizon; items: StrategyItem[] }[] = [];
    for (const horizon of HORIZONS) out.push({ horizon, items: await this.repos.strategyItems.find({ horizon, status: 'active' }, { orderBy: { position: 'asc' }, limit: 20 }) });
    return out;
  }

  async contextText(): Promise<string> {
    const ladder = await this.ladder();
    const lines: string[] = [];
    for (const level of ladder) {
      if (!level.items.length) continue;
      lines.push(`${level.horizon}: ${level.items.map((i) => i.title).join(' | ')}`);
    }
    return lines.join('\n');
  }
}

export type { Task };
