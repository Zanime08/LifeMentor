import type { Repos } from '../db/repos';
import { z, type ZodTypeAny } from 'zod';
import type { WriteContext } from '../db/repo';
import type { Task, Goal, Skill, Project, LearningTopic, LearningPath } from '../domain/types';
import type { TaskService } from '../services/tasks';
import type { GoalService } from '../services/goals';
import type { CalendarService } from '../services/calendar';
import type { ProjectService } from '../services/projects';
import type { SkillService } from '../services/skills';
import type { LearningService } from '../services/learning';
import type { MemoryService } from '../services/memory';
import type { NewsService } from '../services/news';
import type { ProgressService } from '../services/progress';
import type { NotificationService } from '../services/notifications';
import type { ProfileService } from '../services/profile';
import type { SettingsService } from '../services/settings';
import type { KnowledgeService } from '../services/knowledge';
import type { PersonalizationService } from '../services/personalization';
import type { PlannerService } from '../planning/planner';
import { zodToJsonSchema, type ToolSpec } from './types';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';
import { addDays, dayKey } from '../util/time';

const log = createLogger('ai');

/**
 * Tool registry (req. 22, 23): the AI can only act through these typed tools.
 * There is no SQL, no repository handle and no filesystem access anywhere in
 * this layer — every tool maps to a service call, so all writes go through the
 * same validation, transactions, change_log and sync_queue as the UI.
 *
 * Risk model:
 *  - `read`        never needs confirmation;
 *  - `write`       applied immediately (reversible, logged) unless the tool marks
 *                  itself confirmable for that particular change (skill levels,
 *                  confirmed memories, day-plan rewrites, bulk edits);
 *  - `destructive` always requires an explicit user confirmation token.
 */

export type ToolRisk = 'read' | 'write' | 'destructive';

export interface ToolInvocationContext {
  write: WriteContext;
  day: string;
  intent?: string;
  now: Date;
  /** Confirmation ids the user approved for this turn. */
  approved: string[];
  /** Language for user-facing messages produced by tools. */
  language?: string;
}

export interface ConfirmationRequest {
  id: string;
  title: string;
  detail: string;
  tool: string;
  args: unknown;
  risk: ToolRisk;
}

/**
 * The tool refused because the model's reference was not specific enough (`cancel_task "купить
 * хлеб"` with three such tasks). The English sentence is written for the model — it literally says
 * «Ask the user which one they mean — do not pick one yourself» — and it used to be printed to the
 * user, in English, as a *successful* outcome. The item carries the same facts as data, so the
 * interface can ask the question in the reader's language.
 */
export interface NeedsInputItem {
  code: 'ambiguous' | 'not_found';
  /** What kind of thing the model was pointing at: `task`, `goal`, `skill`, `topic`. */
  kind: string;
  /** The reference the model used (usually the words the user said). */
  ref: string;
  /** What the tool did find instead, when there was more than one candidate. */
  candidates: string[];
}

export interface ToolOutcome {
  ok: boolean;
  /** One-line human/LLM readable summary of what happened. */
  message: string;
  data?: unknown;
  /** Set when the tool refused to act without explicit user approval. */
  confirmation?: ConfirmationRequest;
  /** Set when arguments are ambiguous/missing and the model must ask the user. */
  needsInput?: string;
  /** The same refusal as data, for the interface that words it (req. 6, 7). */
  needs_input_item?: NeedsInputItem;
  error?: string;
  tokens?: number;
}

export interface ToolResult { message: string; data?: unknown; ok?: boolean; needsInput?: NeedsInputItem }

export interface ToolDef {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: ZodTypeAny;
  /** When true the registry asks for confirmation before executing. */
  confirm?: (args: any, ctx: ToolInvocationContext) => string | null;
  execute(args: any, ctx: ToolInvocationContext): Promise<ToolResult>;
}

export interface ToolDeps {
  tasks: TaskService;
  goals: GoalService;
  calendar: CalendarService;
  projects: ProjectService;
  skills: SkillService;
  learning: LearningService;
  memory: MemoryService;
  news: NewsService;
  progress: ProgressService;
  notifications: NotificationService;
  profile: ProfileService;
  settings: SettingsService;
  personalization: PersonalizationService;
  planner: PlannerService;
  knowledge?: KnowledgeService;
  /** Read-only access used to report what the planner actually wrote (counts, plan state). */
  repos?: Repos;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(private readonly deps: ToolDeps) {}

  get depsRef(): ToolDeps { return this.deps; }

  register(tool: ToolDef): this {
    if (this.tools.has(tool.name)) throw AppError.validation(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }

  names(): string[] { return [...this.tools.keys()]; }

  byRisk(risk: ToolRisk): ToolDef[] { return [...this.tools.values()].filter((t) => t.risk === risk); }

  /** Tool specs handed to a provider (req. 21) — JSON schema derived from the zod validator. */
  specs(names?: string[]): ToolSpec[] {
    return [...this.tools.values()]
      .filter((tool) => !names || names.includes(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: zodToJsonSchema(tool.parameters) }));
  }

  /**
   * Validate arguments, check confirmation policy, execute, and normalise the
   * result. Never throws for a bad model call: validation failures come back as
   * `needsInput` so the model can repair or ask the user.
   */
  async invoke(name: string, rawArgs: Record<string, unknown>, ctx: ToolInvocationContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, message: `Unknown tool "${name}".`, needsInput: `Available tools: ${this.names().join(', ')}.` };
    }
    const normalised = normaliseArgs(rawArgs ?? {}, tool, ctx);
    const parsed = tool.parameters.safeParse(normalised);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { ok: false, message: `Invalid arguments for ${name}.`, needsInput: issues, error: issues };
    }
    const args = parsed.data;

    const confirmationText = tool.confirm?.(args, ctx) ?? null;
    if (confirmationText) {
      const id = confirmationId(name, args);
      if (!ctx.approved.includes(id) && !ctx.approved.includes(name)) {
        return {
          ok: false,
          message: confirmationText,
          confirmation: { id, title: describeTool(name), detail: confirmationText, tool: name, args, risk: tool.risk },
        };
      }
    }

    try {
      const result = await tool.execute(args, ctx);
      log.debug('tool executed', { tool: name, risk: tool.risk });
      // A tool that could not identify what it was pointed at has not done anything: reporting it
      // as `ok` put a ✓ «отменил задачу» chip on the screen for a call that changed nothing.
      return {
        ok: result.ok !== false,
        message: result.message,
        data: result.data,
        ...(result.needsInput ? { needsInput: result.message, needs_input_item: result.needsInput } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const userMessage = error instanceof AppError && error.userMessage ? error.userMessage : message;
      log.warn('tool failed', { tool: name, error: message });
      return { ok: false, message: userMessage, error: message };
    }
  }
}

// ─────────────────────────── argument normalisation ───────────────────────────
/**
 * Models (and the offline heuristic engine) rarely speak in database terms:
 * they say "tomorrow", "next monday", "at 5pm", or use `title` where the tool
 * wants `task`. Normalising here turns those calls into valid ones instead of
 * bouncing them back, while never inventing data the model did not supply.
 */
const KEY_ALIASES: Record<string, string[]> = {
  task: ['task_title', 'task_name', 'title', 'name', 'task_id', 'id'],
  goal: ['goal_title', 'goal_name', 'title', 'name', 'goal_id', 'id'],
  skill: ['skill_name', 'name', 'skill_id', 'id'],
  topic: ['topic_title', 'topic_name', 'title', 'name', 'topic_id', 'id'],
  project: ['project_title', 'project_name', 'title', 'name', 'project_id', 'id'],
};

const DATE_KEYS = ['day', 'date', 'new_date', 'due_date', 'scheduled_date', 'target_date', 'start_date', 'deadline'];
const TIME_KEYS = ['start', 'end', 'new_start', 'new_end', 'scheduled_start', 'scheduled_end', 'due_time'];

function normaliseArgs(raw: Record<string, unknown>, tool: ToolDef, ctx: ToolInvocationContext): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  const schema = zodToJsonSchema(tool.parameters) as { properties?: Record<string, unknown> };
  const known = new Set(Object.keys(schema.properties ?? {}));

  // 1. aliases → canonical key (only when the canonical key is actually expected and absent)
  for (const [canonical, aliases] of Object.entries(KEY_ALIASES)) {
    if (!known.has(canonical) || args[canonical] !== undefined) continue;
    for (const alias of aliases) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== '') {
        args[canonical] = args[alias];
        if (alias !== canonical && !known.has(alias)) delete args[alias];
        break;
      }
    }
  }

  // 2. relative dates/times → concrete values anchored on the invocation day
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (DATE_KEYS.includes(key) && known.has(key)) {
      const resolved = resolveRelativeDate(value, ctx);
      if (resolved) args[key] = resolved;
    } else if (TIME_KEYS.includes(key) && known.has(key)) {
      const resolved = resolveRelativeTime(value);
      if (resolved) args[key] = resolved;
    }
  }

  // 3. "target" is how the offline engine expresses a move destination
  if (typeof args.target === 'string' && known.has('new_date') && args.new_date === undefined) {
    const asDate = resolveRelativeDate(args.target, ctx);
    const asTime = resolveRelativeTime(args.target);
    if (asDate) args.new_date = asDate;
    else if (asTime && known.has('new_start')) args.new_start = asTime;
    delete args.target;
  }

  // 4. drop keys the tool does not accept so validation reports real problems only
  for (const key of Object.keys(args)) if (!known.has(key)) delete args[key];

  return args;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function resolveRelativeDate(value: string, ctx: { day: string; now: Date }): string | null {
  const text = value.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const base = new Date(`${ctx.day}T12:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  const shift = (days: number) => dayKey(addDays(base, days));

  if (/(^|\b)(today|сегодня|todays)\b/.test(text)) return shift(0);
  if (/(^|\b)(tomorrow|завтра|tmrw)\b/.test(text)) return shift(1);
  if (/(^|\b)(yesterday|вчера)\b/.test(text)) return shift(-1);
  if (/^(tonight|this evening|сегодня вечером)$/.test(text)) return shift(0);

  const inDays = /in\s+(\d{1,3})\s*(day|days|дн)/.exec(text) ?? /через\s+(\d{1,3})\s*(день|дня|дней)/.exec(text);
  if (inDays) return shift(Number(inDays[1]));

  const nextWeek = /next week|на следующей неделе/.test(text);
  for (let index = 0; index < WEEKDAYS.length; index++) {
    if (!new RegExp(`\\b${WEEKDAYS[index]}\\b`).test(text)) continue;
    const current = base.getDay();
    let delta = (index - current + 7) % 7;
    if (delta === 0) delta = 7;
    if (nextWeek) delta += 7;
    return shift(delta);
  }
  if (/next month|в следующем месяце/.test(text)) return shift(30);
  if (/weekend|выходные/.test(text)) {
    const current = base.getDay();
    return shift(current === 0 ? 6 : 6 - current); // upcoming Saturday
  }
  return null;
}

export function resolveRelativeTime(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/^at\s+/, '').replace(/\s*(o'clock|часов|ч\.)$/, '');
  if (/^\d{2}:\d{2}$/.test(text)) return text;
  const hhmm = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(text);
  if (hhmm) {
    let hour = Number(hhmm[1]);
    if (hhmm[3] === 'pm' && hour < 12) hour += 12;
    if (hhmm[3] === 'am' && hour === 12) hour = 0;
    return `${String(Math.min(23, hour)).padStart(2, '0')}:${hhmm[2]}`;
  }
  const bare = /^(\d{1,2})\s*(am|pm)$/.exec(text);
  if (bare) {
    let hour = Number(bare[1]);
    if (bare[2] === 'pm' && hour < 12) hour += 12;
    if (bare[2] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:00`;
  }
  if (/^(\d{1,2})\s*(am|pm)?$/.test(text)) {
    const hour = Number(/^(\d{1,2})/.exec(text)?.[1]);
    if (Number.isFinite(hour) && /pm/.test(text)) return `${String(hour < 12 ? hour + 12 : hour).padStart(2, '0')}:00`;
    if (Number.isFinite(hour)) return `${String(hour).padStart(2, '0')}:00`;
  }
  if (/noon|midday|полдень/.test(text)) return '12:00';
  if (/midnight|полночь/.test(text)) return '00:00';
  if (/morning|утро/.test(text)) return '09:00';
  if (/afternoon|день/.test(text)) return '14:00';
  if (/evening|вечер/.test(text)) return '19:00';
  return null;
}

function describeTool(name: string): string {
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function confirmationId(tool: string, args: unknown): string {
  const raw = `${tool}:${stableStringify(args)}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `confirm_${(hash >>> 0).toString(16)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

// ─────────────────────────── entity resolution ───────────────────────────
/**
 * The model often names an entity instead of supplying its id. Resolution is
 * strict: an id wins, then an exact title, then a single unambiguous fuzzy hit.
 * Anything else is returned as `needsInput` so the user is asked — the AI never
 * guesses which task to complete or delete.
 */
interface Match<T> { item: T | null; candidates: T[]; reason?: string }

/** Accepts bare UUIDv7 ids and the readable prefixed ids `newId()` produces (`task_01…`). */
function isEntityRef(ref: string): boolean {
  return /(?:^|_)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim());
}

function scoreText(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (!n) return 0;
  if (h === n) return 100;
  if (h.includes(n)) return 70;
  const words = n.split(/[^a-zа-я0-9]+/i).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((w) => h.includes(w)).length;
  return Math.round((hits / words.length) * 55);
}

function pick<T>(items: T[], query: string, text: (item: T) => string): Match<T> {
  const exact = items.find((i) => text(i).toLowerCase() === query.toLowerCase().trim());
  if (exact) return { item: exact, candidates: [] };
  const scored = items.map((i) => ({ i, score: scoreText(text(i), query) })).filter((s) => s.score >= 45).sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { item: scored[0].i, candidates: [] };
  if (scored.length > 1 && scored[0].score - (scored[1]?.score ?? 0) >= 20) return { item: scored[0].i, candidates: scored.slice(1, 4).map((s) => s.i) };
  return { item: null, candidates: scored.slice(0, 5).map((s) => s.i), reason: scored.length ? 'ambiguous' : 'not_found' };
}

async function resolveTask(deps: ToolDeps, ref: string, day: string): Promise<Match<Task>> {
  if (isEntityRef(ref)) {
    const byId = await deps.tasks.get(ref);
    if (byId) return { item: byId, candidates: [] };
  }
  const open = [
    ...(await deps.tasks.listForDay(day)),
    ...(await deps.tasks.overdue()),
    ...(await deps.tasks.backlog(200)),
  ];
  const unique = new Map<string, Task>();
  for (const task of open) if (task.status !== 'done' && task.status !== 'cancelled') unique.set(task.id, task);
  return pick([...unique.values()], ref, (t) => t.title);
}

// ─────────────────────────── registry factory ───────────────────────────
export function createTools(deps: ToolDeps): ToolRegistry {
  const registry = new ToolRegistry(deps);

  // ── reads ────────────────────────────────────────────────────────────
  registry.register({
    name: 'get_user_memory',
    description: 'Search the long-term memory of facts, preferences, decisions and insights about the user. Use before assuming anything about them.',
    risk: 'read',
    parameters: z.object({
      query: z.string().max(300).optional().describe('What to recall, e.g. "deadlines", "diet preferences"'),
      limit: z.number().int().min(1).max(30).default(8),
    }),
    async execute(args) {
      const memories = args.query
        ? await deps.memory.search(args.query, { limit: args.limit, includeUnconfirmed: true })
        : (await deps.memory.list({ limit: args.limit, minImportance: 0.4 })).map((m) => ({ ...m, score: 0, matched_by: ['importance'] as const, tags_list: [] }));
      return {
        message: memories.length ? `${memories.length} memories found.` : 'Nothing stored about this yet.',
        data: memories.map((m) => ({ id: m.id, kind: m.kind, content: m.content, confidence: m.confidence, importance: m.importance, tags: m.tags_list ?? [] })),
      };
    },
  });

  registry.register({
    name: 'get_schedule',
    description: 'Read the calendar (fixed reality) and planned tasks for a day. Calendar events are hard constraints.',
    risk: 'read',
    parameters: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, defaults to today') }),
    async execute(args, ctx) {
      const day = args.day ?? ctx.day;
      const [events, tasks, fixed] = await Promise.all([deps.calendar.listDay(day), deps.tasks.listForDay(day), deps.calendar.totalFixedMinutes(day)]);
      return {
        message: `${events.length} events and ${tasks.length} tasks on ${day}; ${fixed}m already committed.`,
        data: {
          day,
          events: events.map((e) => ({ id: e.id, title: e.title, kind: e.kind, priority: e.priority, all_day: e.all_day, starts_at: e.starts_at, ends_at: e.ends_at })),
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, start: t.scheduled_start, end: t.scheduled_end, minutes: t.estimated_minutes })),
          fixed_minutes: fixed,
        },
      };
    },
  });

  registry.register({
    name: 'get_tasks',
    description: 'List tasks: overdue, today, backlog or matching a search phrase.',
    risk: 'read',
    parameters: z.object({
      scope: z.enum(['overdue', 'today', 'backlog', 'search']).default('today'),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    async execute(args, ctx) {
      const list = args.scope === 'overdue' ? await deps.tasks.overdue()
        : args.scope === 'backlog' ? await deps.tasks.backlog(args.limit)
          : args.scope === 'search' && args.query ? (await deps.tasks.backlog(400)).filter((t) => scoreText(t.title, args.query!) >= 40)
            : await deps.tasks.listForDay(ctx.day);
      return {
        message: `${list.length} tasks (${args.scope}).`,
        data: list.slice(0, args.limit).map((t) => ({
          id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date,
          scheduled_date: t.scheduled_date, start: t.scheduled_start, minutes: t.estimated_minutes, postponed: t.postponed_count,
        })),
      };
    },
  });

  registry.register({
    name: 'get_goals',
    description: 'List goals with progress, horizon and deadlines. Include the tree when hierarchy matters.',
    risk: 'read',
    parameters: z.object({ status: z.enum(['active', 'paused', 'achieved', 'all']).default('active'), tree: z.boolean().default(false) }),
    async execute(args) {
      if (args.tree) {
        const tree = await deps.goals.tree();
        return { message: `${tree.length} top-level goals.`, data: tree.map((g) => ({ id: g.id, title: g.title, progress: g.progress, horizon: g.horizon, status: g.status, children: g.children.map((c) => ({ id: c.id, title: c.title, progress: c.progress })) })) };
      }
      const goals = await deps.goals.list(args.status === 'all' ? { includeArchived: true } : { status: args.status });
      return {
        message: `${goals.length} goals (${args.status}).`,
        data: goals.map((g) => ({ id: g.id, title: g.title, horizon: g.horizon, priority: g.priority, progress: g.progress, target_date: g.target_date, status: g.status })),
      };
    },
  });

  registry.register({
    name: 'get_progress',
    description: 'Read real progress statistics: today, this week, streak, completion rate, focus and learning minutes.',
    risk: 'read',
    parameters: z.object({ range: z.enum(['day', 'week', 'overview']).default('overview') }),
    async execute(args, ctx) {
      if (args.range === 'day') {
        const metrics = await deps.progress.dayMetrics(ctx.day);
        return { message: `Progress for ${ctx.day}.`, data: metrics };
      }
      if (args.range === 'week') {
        const overview = await deps.progress.overview();
        return { message: 'This week so far.', data: overview.week };
      }
      const overview = await deps.progress.overview();
      return {
        message: `Streak ${overview.streak} days; 30-day completion ${Math.round(overview.completion_rate_30d * 100)}%.`,
        data: { today: overview.today, week: overview.week, streak: overview.streak, completion_rate_30d: overview.completion_rate_30d, focus_last_7d: overview.focus_last_7d, learning_last_7d: overview.learning_last_7d },
      };
    },
  });

  registry.register({
    name: 'get_skills',
    description: 'List skills with evidence-backed levels and confidence. Levels are never assumptions.',
    risk: 'read',
    parameters: z.object({ domain: z.string().max(80).optional() }),
    async execute(args) {
      const skills = await deps.skills.list(args.domain ? { domain: args.domain } : {});
      return {
        message: `${skills.length} skills tracked.`,
        data: skills.map((s) => ({ id: s.id, name: s.name, domain: s.domain, level: s.level, confidence: s.confidence, weak_points: s.weak_points })),
      };
    },
  });

  registry.register({
    name: 'get_learning',
    description: 'Read learning paths, next topics and due spaced-repetition reviews.',
    risk: 'read',
    parameters: z.object({ include_next: z.boolean().default(true) }),
    async execute(args) {
      const [paths, stats] = await Promise.all([deps.learning.paths({}), deps.learning.stats()]);
      const next = args.include_next ? await deps.learning.nextActions(5) : [];
      const due = await deps.learning.reviewsDueCount();
      return {
        message: `${stats.active_paths} active paths, ${due} reviews due, ${stats.topics_done}/${stats.topics_total} topics done.`,
        data: { paths: paths.map((p) => ({ id: p.id, title: p.title, progress: p.progress, status: p.status })), next, reviews_due: due, stats },
      };
    },
  });

  registry.register({
    name: 'get_news',
    description: 'Read news relevant to the user\'s goals and interests, ranked for them.',
    risk: 'read',
    parameters: z.object({ limit: z.number().int().min(1).max(20).default(6), urgent_only: z.boolean().default(false) }),
    async execute(args) {
      const items = args.urgent_only ? await deps.news.urgent(args.limit) : await deps.news.list({ limit: 40 });
      const ranked = args.urgent_only ? items : await deps.news.rankForUser(items, args.limit);
      return {
        message: ranked.length ? `${ranked.length} news items.` : 'No news available (sources not fetched yet).',
        data: ranked.map((n) => ({ id: n.id, title: n.title, category: n.category, urgency: n.urgency, published_at: n.published_at, url: n.url })),
      };
    },
  });

  registry.register({
    name: 'get_user_model',
    description: 'Read the structured user model (situation, goals, skills, constraints, lifestyle) with confidence labels per field.',
    risk: 'read',
    parameters: z.object({ section: z.string().max(40).optional() }),
    async execute(args) {
      const model = await deps.profile.model();
      const sections = args.section ? { [args.section]: model.sections[args.section as keyof typeof model.sections] ?? [] } : model.sections;
      return { message: 'User model fields, labelled confirmed/observed/assumption.', data: { updated_at: model.updated_at, sections } };
    },
  });

  // ── writes ───────────────────────────────────────────────────────────
  registry.register({
    name: 'create_task',
    description: 'Create a task. Prefer scheduling it only when the user asked for a time or the day plan allows it; leave estimated_minutes realistic.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(1).max(300),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      scheduled_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      estimated_minutes: z.number().int().min(1).max(960).default(30),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
      kind: z.enum(['generic', 'learning', 'practice', 'review', 'project', 'health', 'errand', 'work']).default('generic'),
      goal_id: z.string().optional(),
      project_id: z.string().optional(),
      notes: z.string().max(2000).optional(),
      recurrence: z.string().max(60).optional().describe('daily | weekdays | weekly:<dow> | monthly:<day>'),
    }),
    async execute(args, ctx) {
      if (args.scheduled_date && args.scheduled_start) {
        const conflicts = await deps.calendar.findConflicts(args.scheduled_date, toMin(args.scheduled_start), toMin(args.scheduled_start) + args.estimated_minutes);
        if (conflicts.length) {
          throw AppError.validation(`That slot overlaps "${conflicts[0].title}" (${conflicts[0].starts_at.slice(11, 16)}–${conflicts[0].ends_at.slice(11, 16)}). Pick a free slot or create the task unscheduled.`);
        }
      }
      const task = await deps.tasks.create({
        title: args.title, due_date: args.due_date ?? null, scheduled_date: args.scheduled_date ?? null,
        scheduled_start: args.scheduled_start ?? null, estimated_minutes: args.estimated_minutes, priority: args.priority,
        kind: args.kind, goal_id: args.goal_id ?? null, project_id: args.project_id ?? null, notes: args.notes ?? null,
        recurrence: args.recurrence ?? null,
      }, ctx.write);
      const when = task.scheduled_date ? ` on ${task.scheduled_date}${task.scheduled_start ? ` at ${task.scheduled_start}` : ''}` : task.due_date ? ` due ${task.due_date}` : '';
      return { message: `Task "${task.title}" created${when} (~${task.estimated_minutes}m).`, data: { id: task.id, title: task.title, status: task.status } };
    },
  });

  registry.register({
    name: 'complete_task',
    description: 'Mark a task done. Accepts an id or the task title; ambiguous titles are returned for clarification.',
    risk: 'write',
    parameters: z.object({
      task: z.string().min(1).max(300).describe('Task id or title'),
      actual_minutes: z.number().int().min(0).max(1440).optional(),
      note: z.string().max(500).optional(),
    }),
    async execute(args, ctx) {
      const match = await resolveTask(deps, args.task, ctx.day);
      if (!match.item) return clarification('task', args.task, match.candidates.map((t) => t.title), match.reason);
      if (match.item.status === 'done') return { message: `"${match.item.title}" was already completed.` };
      const task = await deps.tasks.complete(match.item.id, { actual_minutes: args.actual_minutes, note: args.note }, ctx.write);
      return { message: `Completed "${task.title}".`, data: { id: task.id, actual_minutes: task.actual_minutes } };
    },
  });

  registry.register({
    name: 'reschedule_task',
    description: 'Postpone or move a task. A reason is required by the planner for protected tasks; the service may propose a minimal version.',
    risk: 'write',
    parameters: z.object({
      task: z.string().min(1).max(300).describe('Task id or title'),
      new_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      new_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      reason: z.enum(['unexpected_event', 'lack_of_time', 'fatigue', 'illness', 'procrastination', 'low_value', 'other']).optional(),
      note: z.string().max(500).optional(),
    }),
    async execute(args, ctx) {
      const match = await resolveTask(deps, args.task, ctx.day);
      if (!match.item) return clarification('task', args.task, match.candidates.map((t) => t.title), match.reason);
      const result = args.new_date || args.new_start
        ? await deps.tasks.reschedule(match.item.id, { date: args.new_date ?? match.item.scheduled_date ?? dayKey(addDays(ctx.now, 1)), start: args.new_start ?? match.item.scheduled_start ?? null }, ctx.write)
        : null;
      if (result) return { message: `"${result.title}" moved to ${result.scheduled_date ?? 'the backlog'}${result.scheduled_start ? ` at ${result.scheduled_start}` : ''}.`, data: { id: result.id } };
      const postponed = await deps.tasks.postpone(match.item.id, { reason: args.reason ?? null, note: args.note }, ctx.write);
      const minimal = postponed.minimal_version ? ` Minimal version proposed: "${postponed.minimal_version.title}" (~${postponed.minimal_version.estimated_minutes}m).` : '';
      return {
        message: `${postponed.mentor_message ?? `"${match.item.title}" postponed.`}${minimal}${postponed.rescheduled_to ? ` Rescheduled to ${postponed.rescheduled_to}.` : ''}`,
        data: { id: match.item.id, required_reason: postponed.required_reason, rescheduled_to: postponed.rescheduled_to },
      };
    },
  });

  registry.register({
    name: 'update_task',
    description: 'Change a task\'s title, priority, estimate, dates or notes.',
    risk: 'write',
    parameters: z.object({
      task: z.string().min(1).max(300),
      title: z.string().min(1).max(300).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      estimated_minutes: z.number().int().min(1).max(960).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes: z.string().max(2000).optional(),
      goal_id: z.string().optional(),
    }),
    confirm: (args) => (args.priority === 'P0' ? 'Raise this task to P0 (top priority)?' : null),
    async execute(args, ctx) {
      const match = await resolveTask(deps, args.task, ctx.day);
      if (!match.item) return clarification('task', args.task, match.candidates.map((t) => t.title), match.reason);
      const { task: _ref, ...patch } = args;
      const updated = await deps.tasks.update(match.item.id, patch, ctx.write);
      return { message: `Updated "${updated.title}".`, data: { id: updated.id, priority: updated.priority, due_date: updated.due_date } };
    },
  });

  registry.register({
    name: 'create_goal',
    description: 'Create a goal. Horizon must match the timeframe the user stated; never invent a target date or a metric.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(2).max(200),
      horizon: z.enum(['long', 'medium', 'short', 'daily']).default('medium'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
      target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      description: z.string().max(2000).optional(),
      motivation: z.string().max(500).optional().describe('Why this matters to the user, in their words'),
      area: z.string().max(80).optional(),
      parent_id: z.string().optional(),
      metric: z.object({ kind: z.enum(['number', 'boolean', 'habit']), target: z.number().optional(), unit: z.string().optional() }).optional(),
    }),
    async execute(args, ctx) {
      const goal = await deps.goals.create({
        title: args.title, horizon: args.horizon, priority: args.priority, target_date: args.target_date ?? null,
        description: args.description ?? null, motivation: args.motivation ?? null, area: args.area ?? null,
        parent_id: args.parent_id ?? null, metric: args.metric ?? null,
      }, ctx.write);
      const conflicts = await deps.goals.detectConflicts();
      const mine = conflicts.filter((c) => c.a.id === goal.id || c.b.id === goal.id);
      return {
        message: `Goal "${goal.title}" created (${goal.horizon}, ${Math.round(Number(goal.progress))}%).${mine.length ? ` Possible conflict: ${mine[0].reason}` : ''}`,
        data: { id: goal.id, conflicts: mine.map((c) => c.reason) },
      };
    },
  });

  registry.register({
    name: 'update_goal',
    description: 'Update a goal (title, priority, dates, status). Progress is recomputed from real task/metric evidence, not set by opinion.',
    risk: 'write',
    parameters: z.object({
      goal: z.string().min(1).max(200),
      title: z.string().min(2).max(200).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(['active', 'paused', 'achieved', 'abandoned', 'archived']).optional(),
      description: z.string().max(2000).optional(),
    }),
    confirm: (args) => (args.status === 'abandoned' || args.status === 'archived'
      ? `Mark this goal as ${args.status}? This hides it from planning.` : null),
    async execute(args, ctx) {
      const goal = await resolveGoal(deps, args.goal);
      if (!goal.item) return clarification('goal', args.goal, goal.candidates.map((g) => g.title), goal.reason);
      const { goal: _ref, ...patch } = args;
      const updated = await deps.goals.update(goal.item.id, patch, ctx.write);
      return { message: `Goal "${updated.title}" updated (${updated.status}, ${Math.round(Number(updated.progress))}%).`, data: { id: updated.id, status: updated.status } };
    },
  });

  registry.register({
    name: 'create_calendar_event',
    description: 'Add a fixed event (class, work, meeting, exam, commute). Events are reality: the planner works around them and never overlaps a critical one.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(1).max(200),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, defaults to today'),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      kind: z.enum(['class', 'work', 'meeting', 'commute', 'errand', 'training', 'social', 'health', 'exam', 'free', 'other']).default('other'),
      priority: z.enum(['critical', 'normal', 'flexible']).default('normal'),
      location: z.string().max(200).optional(),
      reminder_minutes: z.number().int().min(0).max(10080).optional(),
    }),
    async execute(args, ctx) {
      const day = args.day ?? ctx.day;
      if (toMin(args.end) <= toMin(args.start)) throw AppError.validation('End time must be after the start time.');
      const conflicts = await deps.calendar.findConflicts(day, toMin(args.start), toMin(args.end));
      if (conflicts.length) {
        throw AppError.validation(`"${conflicts[0].title}" already occupies ${conflicts[0].starts_at.slice(11, 16)}–${conflicts[0].ends_at.slice(11, 16)} on ${day}. Choose another slot.`);
      }
      const event = await deps.calendar.create({
        title: args.title, day, start: args.start, end: args.end, kind: args.kind, priority: args.priority,
        location: args.location ?? null, reminder_minutes: args.reminder_minutes ?? null, source: 'ai',
      }, ctx.write);
      return { message: `Event "${event.title}" added on ${day} ${args.start}–${args.end}.`, data: { id: event.id } };
    },
  });

  registry.register({
    name: 'delete_calendar_event',
    description: 'Remove a calendar event. Destructive: requires user confirmation.',
    risk: 'destructive',
    parameters: z.object({ title: z.string().min(1).max(200), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    confirm: (args, ctx) => `Delete the event "${args.title}" from ${args.day ?? ctx.day}? This cannot be undone.`,
    async execute(args, ctx) {
      const day = args.day ?? ctx.day;
      const events = await deps.calendar.listDay(day);
      const found = events.find((e) => scoreText(e.title, args.title) >= 60);
      if (!found) return { message: `No event matching "${args.title}" on ${day}.` };
      await deps.calendar.remove(found.id, ctx.write);
      return { message: `Deleted "${found.title}" on ${day}.`, data: { id: found.id } };
    },
  });

  registry.register({
    name: 'cancel_task',
    description: 'Cancel/delete a task with a reason. Destructive: requires user confirmation.',
    risk: 'destructive',
    parameters: z.object({ task: z.string().min(1).max(300), reason: z.enum(['unexpected_event', 'lack_of_time', 'fatigue', 'illness', 'procrastination', 'low_value', 'other']).optional() }),
    confirm: (args) => `Cancel the task "${args.task}"? It will be removed from planning.`,
    async execute(args, ctx) {
      const match = await resolveTask(deps, args.task, ctx.day);
      if (!match.item) return clarification('task', args.task, match.candidates.map((t) => t.title), match.reason);
      await deps.tasks.cancel(match.item.id, args.reason ?? null, undefined, ctx.write);
      return { message: `Cancelled "${match.item.title}".`, data: { id: match.item.id } };
    },
  });

  registry.register({
    name: 'update_learning_progress',
    description: 'Record a real learning session (study/practice/test/recall) against a topic. Drives topic %, skill evidence and the spaced-repetition queue.',
    risk: 'write',
    parameters: z.object({
      topic: z.string().min(1).max(200).describe('Topic id or title'),
      kind: z.enum(['study', 'practice', 'test', 'recall', 'explanation', 'project']).default('study'),
      minutes: z.number().int().min(0).max(720).default(0),
      score: z.number().min(0).max(100).optional().describe('Result for tests/recall, 0-100'),
      notes: z.string().max(1000).optional(),
    }),
    async execute(args, ctx) {
      const topic = await resolveTopic(deps, args.topic);
      if (!topic.item) return clarification('learning topic', args.topic, topic.candidates.map((t) => t.title), topic.reason);
      const result = await deps.learning.recordProgress({ topic_id: topic.item.id, kind: args.kind, minutes: args.minutes, score: args.score ?? null, notes: args.notes ?? null }, ctx.write);
      return {
        message: `Logged ${args.minutes}m of ${args.kind} on "${result.topic.title}" — topic now ${Math.round(Number(result.topic.progress))}%, path "${result.path.title}" ${Math.round(Number(result.path.progress))}%.`,
        data: { topic_id: result.topic.id, path_id: result.path.id, topic_progress: result.topic.progress },
      };
    },
  });

  registry.register({
    name: 'create_learning_path',
    description: 'Create a learning path with ordered topics for a skill or goal. Only use when the user asks to learn something structured.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(2).max(200),
      description: z.string().max(2000).optional(),
      skill_id: z.string().optional(),
      goal_id: z.string().optional(),
      topics: z.array(z.object({ title: z.string().min(1).max(200), estimated_minutes: z.number().int().min(5).max(480).default(45), outcome: z.string().max(300).optional() })).min(1).max(30),
    }),
    confirm: (args) => (args.topics.length > 8 ? `Create a learning path with ${args.topics.length} topics?` : null),
    async execute(args, ctx) {
      const { path, topics } = await deps.learning.createPath({
        title: args.title, description: args.description ?? null, skill_id: args.skill_id ?? null, goal_id: args.goal_id ?? null,
        topics: args.topics.map((t: { title: string; estimated_minutes: number; outcome?: string }) => ({ title: t.title, estimated_minutes: t.estimated_minutes, outcome: t.outcome ?? null })),
      }, ctx.write);
      return { message: `Learning path "${path.title}" created with ${topics.length} topics (~${topics.reduce((s, t) => s + t.estimated_minutes, 0)}m total).`, data: { id: path.id, topics: topics.map((t) => ({ id: t.id, title: t.title })) } };
    },
  });

  registry.register({
    name: 'assess_skill',
    description: 'Record evidence-backed skill assessment (project, test, practice, exam, real result). Levels only move with evidence — never from a guess.',
    risk: 'write',
    parameters: z.object({
      skill: z.string().min(1).max(120),
      kind: z.enum(['test', 'practice', 'project', 'exam', 'task', 'explanation', 'real_result']),
      score: z.number().min(0).max(100).optional(),
      evidence_type: z.string().max(80).optional(),
      evidence_ref: z.string().max(400).optional().describe('What proves it: project id, task id, link, description'),
      notes: z.string().max(1000).optional(),
    }),
    confirm: (_args) => 'Record this skill assessment? Skill levels are evidence-backed and visible in your profile.',
    async execute(args, ctx) {
      const skill = await resolveSkill(deps, args.skill);
      if (!skill.item) return clarification('skill', args.skill, skill.candidates.map((s) => s.name), skill.reason);
      if (!args.evidence_ref && !args.evidence_type && !args.notes) {
        return { message: 'A skill assessment needs evidence (what was done, tested or built). Ask the user for it — do not guess.' };
      }
      const result = await deps.skills.assess(skill.item.id, {
        kind: args.kind, score: args.score ?? null, evidence_type: args.evidence_type ?? null,
        evidence_ref: args.evidence_ref ?? null, notes: args.notes ?? null,
      }, ctx.write);
      return {
        message: result.changed
          ? `Skill "${result.skill.name}" moved ${result.level_before} → ${result.level_after} based on ${args.kind} evidence.`
          : `Assessment recorded for "${result.skill.name}"; level stays at ${result.level_after} (not enough evidence to move it).`,
        data: { skill_id: result.skill.id, level: result.skill.level, confidence: result.skill.confidence, changed: result.changed },
      };
    },
  });

  registry.register({
    name: 'save_memory',
    description: 'Store a durable fact, preference, decision or insight about the user. Anything you inferred must be marked inferred/uncertain, never confirmed.',
    risk: 'write',
    parameters: z.object({
      content: z.string().min(2).max(1000),
      kind: z.enum(['fact', 'preference', 'goal_change', 'decision', 'event', 'insight', 'behavior', 'skill_evidence']).default('fact'),
      importance: z.number().min(0).max(1).default(0.6),
      confidence: z.enum(['confirmed', 'inferred', 'uncertain']).default('inferred'),
      section: z.string().max(60).optional(),
      tags: z.array(z.string().max(40)).max(10).default([]),
      entity_type: z.string().max(40).optional(),
      entity_id: z.string().max(80).optional(),
      supersedes: z.string().optional().describe('Memory id this replaces'),
    }),
    confirm: (args, ctx) => {
      if (args.confidence === 'confirmed' && ctx.approved.length === 0) {
        return `Save "${args.content}" as a CONFIRMED fact about you?`;
      }
      return null;
    },
    async execute(args, ctx) {
      const memory = await deps.memory.save({
        content: args.content, kind: args.kind, importance: args.importance,
        // Only a user statement is confirmed; anything the model produced is inferred.
        confidence: args.confidence === 'confirmed' && ctx.approved.includes(confirmationId('save_memory', args)) ? 'confirmed' : args.confidence === 'confirmed' ? 'inferred' : args.confidence,
        source: args.confidence === 'confirmed' ? 'user_provided' : 'ai_inferred',
        section: args.section ?? null, tags: args.tags, entity_type: args.entity_type ?? null, entity_id: args.entity_id ?? null,
        supersedes: args.supersedes ?? null, needs_confirmation: args.confidence !== 'confirmed',
      }, ctx.write);
      return { message: `Remembered (${memory.confidence}): ${memory.content}`, data: { id: memory.id, confidence: memory.confidence, needs_confirmation: memory.needs_confirmation } };
    },
  });

  registry.register({
    name: 'delete_memory',
    description: 'Forget a stored memory by id. Destructive: requires user confirmation.',
    risk: 'destructive',
    parameters: z.object({ id: z.string().min(1).max(80), reason: z.string().max(200).optional() }),
    confirm: (args) => `Delete this memory permanently? ${args.reason ?? ''}`.trim(),
    async execute(args, ctx) {
      const existing = await deps.memory.get(args.id);
      if (!existing) return { message: 'That memory no longer exists.' };
      await deps.memory.remove(args.id, ctx.write);
      return { message: `Forgot: ${existing.content}`, data: { id: args.id } };
    },
  });

  registry.register({
    name: 'create_project',
    description: 'Create a project (a multi-step outcome) and optionally link it to a goal.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(2).max(200),
      description: z.string().max(2000).optional(),
      goal_id: z.string().optional(),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      milestones: z.array(z.string().max(200)).max(20).default([]),
    }),
    async execute(args, ctx) {
      const project = await deps.projects.create({ title: args.title, description: args.description ?? null, goal_id: args.goal_id ?? null, deadline: args.deadline ?? null }, ctx.write);
      for (const title of args.milestones.slice(0, 20)) {
        await deps.projects.addMilestone(project.id, { title }, ctx.write);
      }
      return { message: `Project "${project.title}" created${args.milestones.length ? ` with ${args.milestones.length} milestones` : ''}.`, data: { id: project.id } };
    },
  });

  registry.register({
    name: 'plan_day',
    description: 'Generate the day plan from real capacity, calendar constraints and priorities. Rewrites today\'s schedule, so it asks first unless the user asked for a plan.',
    risk: 'write',
    parameters: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from_now: z.boolean().default(true).describe('Only plan the remainder of the day'),
    }),
    confirm: (args, ctx) => {
      const day = args.day ?? ctx.day;
      if (day === ctx.day && ctx.intent === 'plan_day') return null; // user asked for it
      return `Build a plan for ${day}? This reschedules your tasks around your fixed events.`;
    },
    async execute(args, ctx) {
      const day = args.day ?? ctx.day;
      // buildDay persists inside one transaction (and with `now` when we only rebuild the rest of
      // the day) — it already returns the stored plan, so it must not be written a second time.
      const plan = await deps.planner.buildDay(day, args.from_now && day === ctx.day ? { now: ctx.now } : {});
      const tasks = deps.repos
        ? await deps.repos.tasks.find({ scheduled_date: day, status: 'scheduled' }, { limit: 200 })
        : [];
      return {
        message: `Plan for ${day}: ${plan.slots.length} slots, ${plan.focus_minutes}m focus, ${plan.free_minutes}m free time kept${plan.overload ? ' — capacity exceeded, some tasks deferred' : ''}.${plan.deferred.length ? ` Deferred: ${plan.deferred.map((d) => d.title).join(', ')}.` : ''}`,
        data: { day, slots: plan.slots.map((s) => ({ title: s.title, task_id: s.taskId ?? null, start: s.start, end: s.end, kind: s.kind })), deferred: plan.deferred, warnings: plan.warnings, persisted: tasks.length },
      };
    },
  });

  registry.register({
    name: 'send_notification',
    description: 'Send a notification to the user. Goes through the notification gate: quiet hours, per-type prefs, dedupe and the daily budget are enforced by the service, not by you.',
    risk: 'write',
    parameters: z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(500),
      type: z.enum(['daily_plan', 'schedule_start', 'task_reminder', 'learning_review', 'important_news', 'goal_review', 'project_deadline', 'mentor_message', 'daily_digest']).default('mentor_message'),
      importance: z.number().min(0).max(1).default(0.5),
      scheduled_at: z.string().optional().describe('ISO datetime; omit to deliver now'),
      channel: z.enum(['local', 'push', 'in_app']).default('in_app'),
      entity_type: z.string().max(40).optional(),
      entity_id: z.string().max(80).optional(),
    }),
    async execute(args, ctx) {
      const decision = await deps.notifications.create({
        title: args.title, body: args.body, type: args.type, importance: args.importance, channel: args.channel,
        scheduled_at: args.scheduled_at ?? null, entity_type: args.entity_type ?? null, entity_id: args.entity_id ?? null,
        dedupe_key: `ai:${args.type}:${args.title}`,
      }, ctx.write);
      const budget = await deps.notifications.budgetStatus();
      return decision.delivered
        ? { message: `Notification delivered (${budget.remaining}/${budget.limit} left today).${decision.adjusted ? ` It was ${decision.adjusted}.` : ''}`, data: { id: decision.notification.id, scheduled_at: decision.notification.scheduled_at, budget } }
        : { message: `Not sent — the notification gate refused it (${decision.reason}). ${budget.remaining}/${budget.limit} of today's budget remains. Do not retry.`, data: { reason: decision.reason, budget } };
    },
  });

  registry.register({
    name: 'update_user_model',
    description: 'Correct or add a user-model field when the user tells you something new. Inferred values must be marked ai_inferred/uncertain.',
    risk: 'write',
    parameters: z.object({
      fields: z.array(z.object({
        section: z.string().min(1).max(40),
        key: z.string().min(1).max(60),
        value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(120)).max(30)]),
        label: z.string().max(120).optional(),
        source: z.enum(['user_provided', 'ai_inferred', 'system_observed']).default('user_provided'),
        confidence: z.enum(['confirmed', 'inferred', 'uncertain']).default('confirmed'),
      })).min(1).max(12),
    }),
    confirm: (args) => (args.fields.some((f: any) => f.source === 'ai_inferred' && f.confidence === 'confirmed')
      ? 'Some of these fields are your own inference but marked confirmed. Save them as confirmed anyway?' : null),
    async execute(args, ctx) {
      const saved = await deps.profile.setMany(args.fields.map((f: any) => ({
        section: f.section, key: f.key, value: f.value, label: f.label ?? null,
        source: f.source, confidence: f.source === 'user_provided' ? f.confidence : f.confidence === 'confirmed' ? 'inferred' : f.confidence,
      })), ctx.write);
      return { message: `Updated ${saved.length} user-model field(s): ${saved.map((f) => f.key).join(', ')}.`, data: { fields: saved.map((f) => ({ section: f.section, key: f.key, confidence: f.confidence })) } };
    },
  });

  registry.register({
    name: 'search_knowledge',
    description: 'Search the personal knowledge map: concepts, how they relate, gaps and what to learn next.',
    risk: 'read',
    parameters: z.object({ query: z.string().max(200).optional(), suggest_next: z.boolean().default(false), limit: z.number().int().min(1).max(20).default(8) }),
    async execute(args) {
      if (!deps.knowledge) return { message: 'Knowledge map is not enabled.' };
      if (args.suggest_next) {
        const next = await deps.knowledge.suggestNext({ limit: args.limit });
        return { message: `${next.length} suggested next topics.`, data: next.map((n) => ({ id: n.node.id, title: n.node.title, reason: n.reason, score: n.score })) };
      }
      const map = await deps.knowledge.map();
      const filtered = args.query ? map.nodes.filter((n) => scoreText(`${n.title} ${n.summary ?? ''}`, args.query) >= 35).slice(0, args.limit) : map.nodes.slice(0, args.limit);
      return { message: `${filtered.length} knowledge nodes.`, data: { nodes: filtered.map((n) => ({ id: n.id, title: n.title, domain: n.domain, mastery: n.mastery, status: n.status })), gaps: map.gaps?.length ?? 0 } };
    },
  });

  registry.register({
    name: 'get_preferences',
    description: 'Read effective settings: planning style, free-time protection, notification budget, learning targets, privacy flags.',
    risk: 'read',
    parameters: z.object({ group: z.enum(['profile', 'planning', 'notifications', 'ai', 'learning', 'news', 'privacy', 'flags']).optional() }),
    async execute(args) {
      const all = await deps.settings.all();
      const data = args.group ? { [args.group]: all[args.group as keyof typeof all] } : all;
      return { message: args.group ? `${args.group} settings.` : 'All settings.', data };
    },
  });

  return registry;
}

// ─────────────────────────── resolution helpers ───────────────────────────
async function resolveGoal(deps: ToolDeps, ref: string): Promise<Match<Goal>> {
  if (isEntityRef(ref)) {
    const byId = await deps.goals.get(ref);
    if (byId) return { item: byId, candidates: [] };
  }
  const goals = await deps.goals.list({ includeArchived: false });
  return pick(goals, ref, (g) => g.title);
}

async function resolveSkill(deps: ToolDeps, ref: string): Promise<Match<Skill>> {
  if (isEntityRef(ref)) {
    const byId = await deps.skills.get(ref);
    if (byId) return { item: byId, candidates: [] };
  }
  const skills = await deps.skills.list();
  return pick(skills, ref, (s) => `${s.name} ${s.domain ?? ''}`);
}

async function resolveTopic(deps: ToolDeps, ref: string): Promise<Match<LearningTopic & { path_title?: string }>> {
  if (isEntityRef(ref)) {
    const paths = await deps.learning.paths({});
    for (const path of paths) {
      const view = await deps.learning.pathView(path.id);
      const topic = view.topics.find((t) => t.id === ref);
      if (topic) return { item: { ...topic, path_title: view.title }, candidates: [] };
    }
  }
  const paths: LearningPath[] = await deps.learning.paths({});
  const topics: (LearningTopic & { path_title?: string })[] = [];
  for (const path of paths.slice(0, 12)) {
    const view = await deps.learning.pathView(path.id);
    topics.push(...view.topics.map((t) => ({ ...t, path_title: view.title })));
  }
  return pick(topics, ref, (t) => `${t.title} ${t.path_title ?? ''}`);
}

async function resolveProject(deps: ToolDeps, ref: string): Promise<Match<Project>> {
  if (isEntityRef(ref)) {
    const byId = await deps.projects.get(ref);
    if (byId) return { item: byId, candidates: [] };
  }
  const projects = await deps.projects.list();
  return pick(projects, ref, (p) => p.title);
}

function clarification(kind: string, ref: string, candidates: string[], reason?: string): ToolResult {
  const shortlist = candidates.slice(0, 5);
  const item: NeedsInputItem = { code: shortlist.length ? 'ambiguous' : 'not_found', kind, ref, candidates: shortlist };
  // The sentence is what the model reads in its tool result: it names the candidates and tells the
  // model to ask instead of guessing. The user reads the same facts worded by the interface.
  const message = item.code === 'ambiguous'
    ? `Several ${kind}s match "${ref}": ${shortlist.map((c) => `"${c}"`).join(', ')}. Ask the user which one they mean — do not pick one yourself.`
    : `No ${kind} matching "${ref}" was found${reason === 'not_found' ? ' among open items' : ''}. Ask the user to confirm the exact name, or create it first.`;
  return { ok: false, message, needsInput: item };
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export { resolveGoal, resolveSkill, resolveTopic, resolveProject, resolveTask, scoreText, confirmationId, isEntityRef };
