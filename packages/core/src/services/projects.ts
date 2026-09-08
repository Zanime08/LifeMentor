import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { Project, ProjectMilestone, ProjectStatus, Task } from '../domain/types';
import { newId } from '../util/id';
import { addDays, daysUntil, nowIso } from '../util/time';
import { AppError } from '../util/result';

export const CreateProjectSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullish(),
  goal_id: z.string().nullish(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
  start_date: z.string().nullish(),
  deadline: z.string().nullish(),
  status: z.enum(['idea', 'active', 'paused', 'done', 'archived', 'cancelled']).default('active'),
  milestones: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    due_date: z.string().nullish(),
    weight: z.number().min(0.1).max(10).default(1),
  })).max(50).default([]),
  skill_ids: z.array(z.string()).max(20).default([]),
});
export type CreateProjectInput = z.input<typeof CreateProjectSchema>;
export const UpdateProjectSchema = CreateProjectSchema.partial().omit({ milestones: true, skill_ids: true }).extend({
  progress: z.number().min(0).max(100).optional(),
  health: z.enum(['on_track', 'at_risk', 'stalled', 'blocked']).nullish(),
});
export type UpdateProjectInput = z.input<typeof UpdateProjectSchema>;

export interface ProjectDetails {
  project: Project;
  milestones: ProjectMilestone[];
  tasks: Task[];
  skills: { id: string; name: string; level: number; role: string }[];
  task_stats: { total: number; done: number; in_progress: number };
  next_actions: Task[];
}

const STALL_DAYS = 14;

/** Projects tie goals → skills → tasks together (req. 42). */
export class ProjectService {
  constructor(private readonly repos: Repos) {}

  async create(input: CreateProjectInput, ctx: WriteContext = USER_WRITE): Promise<Project> {
    const parsed = CreateProjectSchema.parse(input);
    if (parsed.goal_id && !(await this.repos.goals.byId(parsed.goal_id))) throw AppError.notFound('goal', parsed.goal_id);
    const project = await this.repos.projects.insert({
      id: newId('project'),
      title: parsed.title,
      description: parsed.description ?? null,
      goal_id: parsed.goal_id ?? null,
      status: parsed.status,
      priority: parsed.priority,
      start_date: parsed.start_date ?? null,
      deadline: parsed.deadline ?? null,
      progress: 0,
      health: 'on_track',
      last_activity_at: nowIso(),
    } as never, { ...ctx, reason: 'project created' });

    let position = 0;
    for (const milestone of parsed.milestones) {
      await this.repos.projectMilestones.insert({
        id: newId('milestone'), project_id: project.id, title: milestone.title, description: milestone.description ?? null,
        position: position++, due_date: milestone.due_date ?? null, status: 'pending', weight: milestone.weight,
        completed_at: null,
      } as never, ctx);
    }
    for (const skillId of parsed.skill_ids) await this.linkSkill(project.id, skillId, 'builds', ctx);
    return project;
  }

  async update(id: string, patch: UpdateProjectInput, ctx: WriteContext = USER_WRITE): Promise<Project> {
    const before = await this.repos.projects.byId(id);
    if (!before) throw AppError.notFound('project', id);
    const parsed = UpdateProjectSchema.parse(patch);
    const record: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'goal_id', 'priority', 'start_date', 'deadline', 'status', 'progress', 'health'] as const) {
      if (parsed[key] !== undefined) record[key] = parsed[key] ?? null;
    }
    if (parsed.status === 'done') record.progress = 100;
    const updated = await this.repos.projects.update(id, record as never, { ...ctx, reason: ctx.reason ?? 'project updated' });
    if (!updated) throw AppError.notFound('project', id);
    return updated;
  }

  async get(id: string): Promise<Project | null> { return (await this.repos.projects.byId(id)) ?? null; }

  async list(filter: { status?: ProjectStatus | ProjectStatus[] } = {}): Promise<Project[]> {
    const where: Record<string, unknown> = filter.status ? { status: filter.status } : { status: { op: 'not_in', value: ['archived', 'cancelled'] } };
    return this.repos.projects.find(where as never, { orderBy: { priority: 'asc', updated_at: 'desc' }, limit: 300 });
  }

  async details(id: string): Promise<ProjectDetails> {
    const project = await this.repos.projects.byId(id);
    if (!project) throw AppError.notFound('project', id);
    const [milestones, tasks, links] = await Promise.all([
      this.repos.projectMilestones.find({ project_id: id }, { orderBy: { position: 'asc' }, limit: 200 }),
      this.repos.tasks.find({ project_id: id }, { orderBy: { status: 'asc', priority: 'asc' }, limit: 500 }),
      this.repos.projectSkills.find({ project_id: id }, { limit: 100 }),
    ]);
    const skills = [];
    for (const link of links) {
      const skill = await this.repos.skills.byId(link.skill_id);
      if (skill) skills.push({ id: skill.id, name: skill.name, level: Number(skill.level), role: link.role });
    }
    return {
      project,
      milestones,
      tasks,
      skills,
      task_stats: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        in_progress: tasks.filter((t) => t.status === 'in_progress').length,
      },
      next_actions: tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').slice(0, 5),
    };
  }

  async addMilestone(projectId: string, input: { title: string; description?: string | null; due_date?: string | null; weight?: number }, ctx: WriteContext = USER_WRITE): Promise<ProjectMilestone> {
    if (!(await this.repos.projects.byId(projectId))) throw AppError.notFound('project', projectId);
    const existing = await this.repos.projectMilestones.count({ project_id: projectId });
    return this.repos.projectMilestones.insert({
      id: newId('milestone'), project_id: projectId, title: input.title.trim(), description: input.description ?? null,
      position: existing, due_date: input.due_date ?? null, status: 'pending', weight: input.weight ?? 1, completed_at: null,
    } as never, ctx);
  }

  async updateMilestone(id: string, patch: { title?: string; description?: string | null; due_date?: string | null; status?: ProjectMilestone['status']; weight?: number; position?: number }, ctx: WriteContext = USER_WRITE): Promise<ProjectMilestone> {
    const before = await this.repos.projectMilestones.byId(id);
    if (!before) throw AppError.notFound('milestone', id);
    const record: Record<string, unknown> = { ...patch };
    if (patch.status === 'done' && !before.completed_at) record.completed_at = nowIso();
    if (patch.status && patch.status !== 'done') record.completed_at = null;
    const updated = await this.repos.projectMilestones.update(id, record as never, { ...ctx, reason: 'milestone updated' });
    await this.recomputeProgress(before.project_id, ctx);
    await this.touch(before.project_id, ctx);
    return updated!;
  }

  async completeMilestone(id: string, ctx: WriteContext = USER_WRITE): Promise<ProjectMilestone> {
    return this.updateMilestone(id, { status: 'done' }, ctx);
  }

  async removeMilestone(id: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const milestone = await this.repos.projectMilestones.byId(id);
    if (!milestone) return false;
    await this.repos.projectMilestones.softDelete(id, ctx);
    await this.recomputeProgress(milestone.project_id, ctx);
    return true;
  }

  async linkSkill(projectId: string, skillId: string, role: 'builds' | 'requires' = 'builds', ctx: WriteContext = USER_WRITE): Promise<void> {
    const existing = await this.repos.projectSkills.findOne({ project_id: projectId, skill_id: skillId });
    if (existing) return;
    await this.repos.projectSkills.insert({ id: newId(), project_id: projectId, skill_id: skillId, role, created_at: nowIso() } as never, ctx);
  }

  async unlinkSkill(projectId: string, skillId: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    const link = await this.repos.projectSkills.findOne({ project_id: projectId, skill_id: skillId });
    if (link) await this.repos.projectSkills.hardDelete(link.id, ctx);
  }

  /** Progress = weighted milestones (60%) + task completion (40%), whichever evidence exists. */
  async recomputeProgress(id: string, ctx: WriteContext = USER_WRITE): Promise<number> {
    const project = await this.repos.projects.byId(id);
    if (!project) return 0;
    const [milestones, tasks] = await Promise.all([
      this.repos.projectMilestones.find({ project_id: id }, { limit: 200 }),
      this.repos.tasks.find({ project_id: id }, { limit: 500 }),
    ]);
    const milestoneTotal = milestones.reduce((acc, m) => acc + Number(m.weight ?? 1), 0);
    const milestoneDone = milestones.filter((m) => m.status === 'done').reduce((acc, m) => acc + Number(m.weight ?? 1), 0);
    const milestonePct = milestoneTotal > 0 ? (milestoneDone / milestoneTotal) * 100 : null;

    const taskTotal = tasks.length;
    const taskDone = tasks.filter((t) => t.status === 'done').length;
    const taskPct = taskTotal > 0 ? (taskDone / taskTotal) * 100 : null;

    let progress: number;
    if (milestonePct !== null && taskPct !== null) progress = milestonePct * 0.6 + taskPct * 0.4;
    else progress = milestonePct ?? taskPct ?? Number(project.progress ?? 0);
    progress = Math.round(Math.max(0, Math.min(100, progress)));

    if (progress !== Number(project.progress)) {
      await this.repos.projects.update(id, { progress } as never, { ...ctx, reason: 'project progress recomputed', audit: true });
    }
    return progress;
  }

  /** Health is derived from evidence: activity recency, deadline distance, progress. */
  async assessHealth(id: string, ctx: WriteContext = USER_WRITE): Promise<Project['health']> {
    const project = await this.repos.projects.byId(id);
    if (!project) return null;
    if (project.status === 'done' || project.status === 'archived' || project.status === 'cancelled') return project.health;
    if (project.health === 'blocked') return 'blocked'; // explicit user/AI state, not overridden

    const lastActivity = project.last_activity_at ?? project.updated_at;
    const idleDays = Math.abs(daysUntil(lastActivity));
    const daysToDeadline = project.deadline ? daysUntil(project.deadline) : null;
    const progress = Number(project.progress ?? 0);

    let health: Project['health'] = 'on_track';
    if (idleDays >= STALL_DAYS) health = 'stalled';
    else if (daysToDeadline !== null && daysToDeadline <= 14 && progress < 60) health = 'at_risk';
    else if (daysToDeadline !== null && daysToDeadline < 0 && progress < 100) health = 'at_risk';

    if (health !== project.health) {
      await this.repos.projects.update(id, { health } as never, { ...ctx, reason: `health reassessed (idle ${idleDays}d, progress ${progress}%)` });
    }
    return health;
  }

  async touch(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.repos.projects.update(id, { last_activity_at: nowIso() } as never, { ...ctx, audit: false });
  }

  async archive(id: string, ctx: WriteContext = USER_WRITE): Promise<Project> {
    return this.update(id, { status: 'archived' }, { ...ctx, reason: 'project archived' });
  }

  async complete(id: string, ctx: WriteContext = USER_WRITE): Promise<Project> {
    return this.update(id, { status: 'done', progress: 100 }, { ...ctx, reason: 'project completed' });
  }

  /** Projects that need attention — used by dashboard, weekly review and the AI. */
  async needsAttention(): Promise<{ project: Project; reason: string }[]> {
    const projects = await this.list();
    const out: { project: Project; reason: string }[] = [];
    for (const project of projects) {
      const health = await this.assessHealth(project.id);
      if (health === 'stalled') out.push({ project, reason: `No activity for ${STALL_DAYS}+ days` });
      else if (health === 'at_risk') out.push({ project, reason: `Deadline ${project.deadline} with ${Math.round(Number(project.progress))}% done` });
      else if (health === 'blocked') out.push({ project, reason: 'Marked as blocked' });
    }
    return out;
  }

  async contextText(limit = 3): Promise<string> {
    const projects = (await this.list({ status: ['active', 'paused'] })).slice(0, limit);
    const lines: string[] = [];
    for (const p of projects) {
      const deadline = p.deadline ? `, deadline ${p.deadline} (${daysUntil(p.deadline)}d)` : '';
      const milestones = await this.repos.projectMilestones.find({ project_id: p.id }, { orderBy: { position: 'asc' }, limit: 20 });
      const next = milestones.find((m) => m.status !== 'done');
      lines.push(`- ${p.title} — ${Math.round(Number(p.progress))}%, ${p.health ?? 'on_track'}${deadline}${next ? `, next milestone: ${next.title}` : ''}`);
    }
    return lines.join('\n');
  }

  async upcomingDeadlines(days = 14): Promise<Project[]> {
    const until = addDays(new Date(), days).toISOString().slice(0, 10);
    const projects = await this.list({ status: 'active' });
    return projects.filter((p) => p.deadline && p.deadline <= until).sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? ''));
  }
}
