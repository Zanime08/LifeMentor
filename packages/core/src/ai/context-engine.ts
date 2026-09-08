import type { GoalService } from '../services/goals';
import type { TaskService } from '../services/tasks';
import type { CalendarService } from '../services/calendar';
import type { ProjectService } from '../services/projects';
import type { SkillService } from '../services/skills';
import type { LearningService } from '../services/learning';
import type { MemoryService } from '../services/memory';
import type { NewsService } from '../services/news';
import type { ProgressService } from '../services/progress';
import type { PersonalizationService } from '../services/personalization';
import type { ProfileService } from '../services/profile';
import type { SettingsService, SettingsMap } from '../services/settings';
import type { KnowledgeService } from '../services/knowledge';
import type { PlannerService } from '../planning/planner';
import { estimateTokens, truncateToTokens } from './types';
import { createLogger } from '../util/logging';
import { dayKey } from '../util/time';

const log = createLogger('ai');

/**
 * Context Engine (req. 25): never dump the whole database into a prompt.
 *
 * Every section is built from a bounded service query, labelled with an ALL-CAPS
 * heading (the offline provider parses those headings directly), scored by
 * priority/relevance, and truncated or dropped to fit the token budget from
 * `settings.ai.context_budget_tokens`.
 */

export type ContextSectionId =
  | 'user_model' | 'constraints' | 'goals' | 'today' | 'next_tasks' | 'projects'
  | 'skills' | 'learning' | 'progress' | 'memory' | 'patterns' | 'news' | 'knowledge';

export interface ContextDeps {
  profile: ProfileService;
  settings: SettingsService;
  goals: GoalService;
  tasks: TaskService;
  calendar: CalendarService;
  projects: ProjectService;
  skills: SkillService;
  learning: LearningService;
  memory: MemoryService;
  news: NewsService;
  progress: ProgressService;
  personalization: PersonalizationService;
  planner: PlannerService;
  knowledge?: KnowledgeService;
}

export interface ContextRequest {
  /** The user's message — used to retrieve relevant memories and to weight sections. */
  query?: string;
  intent?: string;
  day?: string;
  /** Overrides settings.ai.context_budget_tokens. */
  budgetTokens?: number;
  /** Restrict to these sections (required ones are always added). */
  sections?: ContextSectionId[];
  /** Force extra sections in even if relevance scoring would drop them. */
  always?: ContextSectionId[];
}

export interface BuiltSection {
  id: ContextSectionId;
  label: string;
  text: string;
  tokens: number;
  allocatedTokens: number;
  truncated: boolean;
  dropped: boolean;
  priority: number;
}

export interface BuiltContext {
  text: string;
  header: string;
  sections: BuiltSection[];
  included: ContextSectionId[];
  dropped: ContextSectionId[];
  totalTokens: number;
  budgetTokens: number;
  language: string;
  warnings: string[];
  settings: SettingsMap;
  day: string;
}

interface SectionDef {
  id: ContextSectionId;
  label: string;
  /** Higher = kept longer when the budget is tight. */
  priority: number;
  /** Always included, truncated rather than dropped. */
  required?: boolean;
  /** Tokens reserved for this section when it is required. */
  floor?: number;
  build: (deps: ContextDeps, request: ResolvedRequest, settings: SettingsMap) => Promise<string>;
}

interface ResolvedRequest extends ContextRequest { day: string; query: string }

/** Intent → sections that matter most for that kind of question. */
const RELEVANCE: Record<string, Partial<Record<ContextSectionId, number>>> = {
  news: { news: 40, memory: 4 },
  next_action: { next_tasks: 30, today: 20, goals: 10, patterns: 8 },
  plan_day: { today: 30, next_tasks: 24, constraints: 16, patterns: 10, goals: 6 },
  progress: { progress: 40, learning: 14, goals: 12, patterns: 8 },
  memory_review: { memory: 40, user_model: 20, goals: 6 },
  advice: { user_model: 16, goals: 16, memory: 14, patterns: 12, skills: 8, constraints: 8 },
  add_task: { next_tasks: 20, today: 16, constraints: 10 },
  complete_task: { next_tasks: 16, today: 14, progress: 10 },
  postpone_task: { next_tasks: 18, today: 16, patterns: 12, constraints: 8 },
  add_goal: { goals: 26, user_model: 14, memory: 10, skills: 6 },
  schedule_event: { today: 26, constraints: 14, next_tasks: 8 },
  log_learning: { learning: 26, skills: 14, progress: 8 },
  learning: { learning: 30, skills: 16, knowledge: 10, goals: 6 },
  career: { user_model: 16, goals: 16, skills: 16, memory: 10, knowledge: 6 },
  small_talk: { user_model: 10, memory: 8 },
};

const SECTIONS: SectionDef[] = [
  {
    id: 'user_model', label: 'USER MODEL', priority: 100, required: true, floor: 220,
    build: async (deps) => deps.profile.contextText(5),
  },
  {
    id: 'constraints', label: 'CONSTRAINTS AND TIME BUDGET', priority: 88, required: true, floor: 120,
    build: async (deps, _req, settings) => {
      const p = settings.planning;
      const lines = [
        `- Wake ${p.wake_time}, sleep ${p.sleep_time}, working window ${p.work_start}–${p.work_end}`,
        `- Hard limit ${p.max_focus_hours_per_day}h focused work/day, break every ${p.break_every_minutes}m, buffer ${p.buffer_minutes}m`,
        `- Protected free time ${p.free_time_minutes}m/day — never schedule over it`,
        `- Planning style: ${p.style} (strictness ${p.strictness}), reminders ${p.reminder_style}`,
      ];
      const fixed = await deps.calendar.totalFixedMinutes(settingsDay(_req));
      if (fixed > 0) lines.push(`- Already committed today: ${fixed}m of fixed events`);
      const plan = await deps.planner.lastPlan();
      if (plan && plan.day === _req.day) {
        lines.push(`- Today's plan: ${plan.slots.length} slots, ${plan.focus_minutes}m focus, ${plan.free_minutes}m free${plan.overload ? ' — OVERLOADED' : ''}`);
        if (plan.deferred.length) lines.push(`- Deferred today: ${plan.deferred.map((d) => `${d.title} (${d.reason})`).slice(0, 4).join('; ')}`);
      }
      return lines.join('\n');
    },
  },
  {
    id: 'today', label: 'TODAY', priority: 95, required: true, floor: 160,
    build: async (deps, req) => {
      const events = await deps.calendar.contextText(req.day, 1);
      const tasks = await deps.tasks.listForDay(req.day);
      const scheduled = tasks
        .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
        .map((t) => `  - ${t.scheduled_start ? `${t.scheduled_start}–${t.scheduled_end ?? '?'}` : 'any time'} ${t.title} (~${t.estimated_minutes}m, ${t.priority})`)
        .join('\n');
      const parts = [events && `Fixed events:\n${events}`, scheduled && `Planned tasks:\n${scheduled}`].filter(Boolean);
      if (!parts.length) return 'Nothing scheduled today.';
      return parts.join('\n');
    },
  },
  {
    id: 'next_tasks', label: 'NEXT TASKS', priority: 90, required: true, floor: 160,
    build: async (deps, _req, settings) => {
      const lines: string[] = [];
      const overdue = await deps.tasks.overdue();
      if (overdue.length) lines.push(`Overdue (${overdue.length}):`, ...overdue.slice(0, 5).map((t) => `  - ${t.title} (due ${t.due_date}, ${t.priority})`));
      const next = await deps.tasks.contextText(8);
      if (next) lines.push('Queue:', next);
      void settings;
      return lines.join('\n');
    },
  },
  {
    id: 'goals', label: 'CURRENT GOALS', priority: 85, required: true, floor: 140,
    build: async (deps) => deps.goals.contextText(6),
  },
  {
    id: 'memory', label: 'RELEVANT MEMORY', priority: 80, required: true, floor: 160,
    build: async (deps, req, settings) => {
      if (!settings.ai.memory_enabled) return '';
      return deps.memory.contextText(req.query || 'user profile goals preferences', 8);
    },
  },
  {
    id: 'progress', label: 'RECENT PROGRESS', priority: 62, floor: 120,
    build: async (deps, req) => {
      const overview = await deps.progress.overview();
      const lines = [
        `- Today: ${overview.today.tasks_completed} tasks done, ${overview.today.focus_minutes}m focus, ${overview.today.learning_minutes}m learning`,
        `- This week: ${overview.week.tasks_completed} tasks, ${overview.week.focus_minutes}m focus, completion ${Math.round(overview.week.completion_rate * 100)}%`,
        `- Streak ${overview.streak}d, 30-day completion ${Math.round(overview.completion_rate_30d * 100)}%`,
      ];
      const series = await deps.progress.series(7);
      const trend = series.map((d) => `${d.day.slice(5)}:${Math.round(d.completion_rate * 100)}%`).join(' ');
      if (series.length >= 3) lines.push(`- Last 7 days completion: ${trend}`);
      void req;
      return lines.join('\n');
    },
  },
  {
    id: 'learning', label: 'CURRENT LEARNING', priority: 60, floor: 110,
    build: async (deps) => deps.learning.contextText(),
  },
  {
    id: 'skills', label: 'SKILLS', priority: 55, floor: 100,
    build: async (deps) => deps.skills.contextText(8),
  },
  {
    id: 'projects', label: 'ACTIVE PROJECTS', priority: 52, floor: 90,
    build: async (deps) => {
      const text = await deps.projects.contextText(3);
      const attention = await deps.projects.needsAttention();
      if (!attention.length) return text;
      return [text, `Needs attention: ${attention.slice(0, 3).map((a) => `${a.project.title} (${a.reason})`).join('; ')}`].filter(Boolean).join('\n');
    },
  },
  {
    id: 'patterns', label: 'OBSERVED PATTERNS', priority: 50, floor: 90,
    build: async (deps) => {
      const lines = await deps.personalization.describe();
      if (!lines.length) return '';
      return lines.map((l) => `- ${l}`).join('\n') + '\n(Treat these as observations, not facts about identity.)';
    },
  },
  {
    id: 'knowledge', label: 'KNOWLEDGE MAP', priority: 34, floor: 80,
    build: async (deps) => (deps.knowledge ? deps.knowledge.contextText(8) : ''),
  },
  {
    id: 'news', label: 'IMPORTANT NEWS', priority: 30, floor: 80,
    build: async (deps, _req, settings) => {
      if (!settings.news.enabled) return '';
      return deps.news.contextText(4);
    },
  },
];

const HEADER_RESERVE_TOKENS = 260;

export class ContextEngine {
  constructor(private readonly deps: ContextDeps) {}

  /** Build the bounded context packet for one AI call. */
  async build(request: ContextRequest = {}): Promise<BuiltContext> {
    const settings = await this.deps.settings.all();
    const day = request.day ?? dayKey();
    const resolved: ResolvedRequest = { ...request, day, query: request.query ?? '' };
    const budget = Math.max(800, request.budgetTokens ?? settings.ai.context_budget_tokens ?? 6000);
    const warnings: string[] = [];

    const wanted = this.selectSections(request, settings, day);
    const built = await this.buildAll(wanted, resolved, settings, warnings);

    const allocated = this.allocate(built, budget - HEADER_RESERVE_TOKENS, request.always ?? []);
    const included = allocated.filter((s) => !s.dropped);
    const header = this.header(settings, day, request.intent);

    return {
      text: [header, ...included.map((s) => `## ${s.label}\n${s.text}`)].join('\n\n'),
      header,
      sections: allocated,
      included: included.map((s) => s.id),
      dropped: allocated.filter((s) => s.dropped).map((s) => s.id),
      totalTokens: estimateTokens(header) + included.reduce((sum, s) => sum + s.tokens, 0),
      budgetTokens: budget,
      language: settings.ai.language || settings.profile.locale || 'en',
      warnings,
      settings,
      day,
    };
  }

  /** Context packet rendered as the system message for a provider call. */
  async systemPrompt(request: ContextRequest = {}): Promise<{ system: string; context: BuiltContext }> {
    const context = await this.build(request);
    return { system: context.text, context };
  }

  private selectSections(request: ContextRequest, settings: SettingsMap, day: string): SectionDef[] {
    const explicit = request.sections;
    void day;
    return SECTIONS.filter((section) => {
      if (explicit && explicit.length) return explicit.includes(section.id) || Boolean(section.required);
      if (section.id === 'news' && !settings.news.enabled) return false;
      if (section.id === 'knowledge' && !this.deps.knowledge) return false;
      if (section.id === 'memory' && !settings.ai.memory_enabled) return false;
      return true;
    });
  }

  private async buildAll(sections: SectionDef[], request: ResolvedRequest, settings: SettingsMap, warnings: string[]): Promise<BuiltSection[]> {
    const relevance = RELEVANCE[request.intent ?? ''] ?? {};
    const results = await Promise.all(sections.map(async (section): Promise<BuiltSection> => {
      const base: BuiltSection = {
        id: section.id, label: section.label, text: '', tokens: 0, allocatedTokens: 0,
        truncated: false, dropped: false, priority: section.priority + (relevance[section.id] ?? 0),
      };
      try {
        const text = (await section.build(this.deps, request, settings)).trim();
        base.text = text;
        base.tokens = estimateTokens(text);
      } catch (error) {
        warnings.push(`${section.id}: ${error instanceof Error ? error.message : String(error)}`);
        log.warn('context section failed', { section: section.id, error: error instanceof Error ? error.message : String(error) });
      }
      return base;
    }));
    return results.filter((s) => s.text.length > 0);
  }

  /**
   * Budget allocation: required sections always survive (truncated first),
   * then remaining budget goes to the highest-priority sections in order.
   * A section that cannot get at least 40 tokens is dropped rather than
   * included as noise.
   */
  private allocate(built: BuiltSection[], budget: number, always: ContextSectionId[]): BuiltSection[] {
    const order = [...built].sort((a, b) => b.priority - a.priority);
    const required = order.filter((s) => SECTIONS.find((d) => d.id === s.id)?.required || always.includes(s.id));
    const optional = order.filter((s) => !required.includes(s));

    let remaining = Math.max(200, budget);

    // Pass 1: required sections get at least their floor, or a fair share when tight.
    const fairShare = Math.floor(remaining / Math.max(1, required.length));
    for (const section of required) {
      const floor = SECTIONS.find((d) => d.id === section.id)?.floor ?? 80;
      const want = Math.max(Math.min(section.tokens, fairShare), Math.min(floor, section.tokens));
      const grant = Math.max(40, Math.min(want, remaining));
      this.fit(section, grant);
      remaining -= section.tokens;
    }

    // Pass 2: optional sections in priority order until the budget runs out.
    for (const section of optional) {
      if (remaining < 40) { section.dropped = true; section.allocatedTokens = 0; section.text = ''; section.tokens = 0; continue; }
      this.fit(section, Math.min(section.tokens, remaining));
      remaining -= section.tokens;
    }

    return order;
  }

  private fit(section: BuiltSection, grant: number): void {
    section.allocatedTokens = grant;
    if (section.tokens <= grant) return;
    section.text = truncateToTokens(section.text, Math.max(20, grant - 4));
    section.tokens = estimateTokens(section.text);
    section.truncated = true;
  }

  private header(settings: SettingsMap, day: string, intent?: string): string {
    const name = settings.profile.display_name ?? 'the user';
    const lines = [
      'You are LifeMentor, a long-term personal development system — not a generic chatbot.',
      `Today is ${day}. Language: ${settings.ai.language || settings.profile.locale || 'en'}. Address the user as ${name}.`,
      'Rules:',
      '- Use ONLY the data below. Never invent facts, tasks, dates, numbers or achievements.',
      '- Items marked (assumption) or (observed) are not confirmed: say so instead of stating them as facts.',
      '- Act through tools. Never claim something was saved, scheduled or changed unless a tool call succeeded.',
      `- Planning: ${settings.planning.style}; protect ${settings.planning.free_time_minutes} minutes of free time daily; never propose an impossible schedule.`,
      `- Notifications: budget ${settings.notifications.daily_budget}/day, quiet hours ${settings.notifications.quiet_start ?? 'off'}–${settings.notifications.quiet_end ?? 'off'}. Do not spam.`,
      '- Be concrete and brief: one clear next step beats five vague options.',
      intent ? `- Detected intent: ${intent}.` : '',
      '',
    ].filter((l) => l !== undefined);
    return lines.join('\n');
  }
}

function settingsDay(req: ResolvedRequest): string { return req.day; }

/**
 * Trim a conversation to a token budget, keeping the most recent turns and
 * always keeping at least the last user message (req. 25: bounded prompts).
 */
export function trimHistory<M extends { role: string; content: string }>(messages: M[], budgetTokens = 1800): M[] {
  if (!messages.length) return messages;
  let total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= budgetTokens) return messages;
  const kept: M[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const cost = estimateTokens(message.content);
    if (total - cost < budgetTokens * 0.45 && kept.length >= 4) break;
    kept.unshift(message);
    total -= cost;
    if (total <= budgetTokens) break;
  }
  if (!kept.length) {
    const last = messages[messages.length - 1];
    kept.push({ ...last, content: truncateToTokens(last.content, budgetTokens) });
  }
  return kept;
}
