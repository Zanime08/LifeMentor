import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { AssessmentKind, Confidence, Skill, SkillAssessment } from '../domain/types';
import { newId } from '../util/id';
import { addDays, daysUntil, nowIso } from '../util/time';
import { AppError } from '../util/result';

export const CreateSkillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().max(80).nullish(),
  description: z.string().trim().max(2000).nullish(),
  /** 0..100. Without an assessment this is a *self-rating* and confidence stays `uncertain`. */
  level: z.number().int().min(0).max(100).default(0),
  self_rating: z.number().int().min(0).max(100).nullish(),
  weak_points: z.array(z.string().max(200)).max(30).default([]),
  goal_id: z.string().nullish(),
});
export type CreateSkillInput = z.input<typeof CreateSkillSchema>;

export const AssessSkillSchema = z.object({
  kind: z.enum(['test', 'practice', 'project', 'exam', 'task', 'explanation', 'real_result']),
  /** 0..100 score of this assessment. */
  score: z.number().min(0).max(100).nullish(),
  evidence_type: z.string().max(80).nullish(),
  evidence_ref: z.string().max(400).nullish(),
  notes: z.string().max(2000).nullish(),
  /** Explicit new level; if omitted it is derived from the score. */
  level_after: z.number().int().min(0).max(100).nullish(),
});
export type AssessSkillInput = z.input<typeof AssessSkillSchema>;

export interface SkillView extends Skill {
  weak_points_list: string[];
  evidence_list: unknown[];
  assessments: SkillAssessment[];
  days_to_next_assessment: number | null;
}

/**
 * Skills (req. 40, 41). A level is *evidence-backed*: it can only move through an assessment
 * row that carries evidence (project, test, practice, exam, task, explanation, real result).
 * The AI cannot raise a level because it "feels" so — `assess()` refuses without evidence.
 */
export class SkillService {
  constructor(private readonly repos: Repos) {}

  async create(input: CreateSkillInput, ctx: WriteContext = USER_WRITE): Promise<Skill> {
    const parsed = CreateSkillSchema.parse(input);
    const duplicate = await this.repos.skills.findOne({ name: parsed.name, domain: parsed.domain ?? null });
    if (duplicate) throw AppError.conflict(`Skill "${parsed.name}" already exists`, { id: duplicate.id });

    const assessed = parsed.level > 0;
    const confidence: Confidence = assessed ? 'inferred' : 'uncertain';
    const skill = await this.repos.skills.insert({
      id: newId('skill'),
      name: parsed.name,
      domain: parsed.domain ?? null,
      description: parsed.description ?? null,
      level: parsed.level,
      confidence,
      self_rating: parsed.self_rating ?? (parsed.level > 0 ? parsed.level : null),
      weak_points: JSON.stringify(parsed.weak_points),
      evidence_json: JSON.stringify([]),
      goal_id: parsed.goal_id ?? null,
      last_assessment_at: null,
      next_assessment_at: assessed ? addDays(new Date(), this.intervalFor(parsed.level)).toISOString().slice(0, 10) : null,
    } as never, { ...ctx, reason: 'skill created' });
    return skill;
  }

  async update(id: string, patch: Partial<{ name: string; domain: string | null; description: string | null; weak_points: string[]; goal_id: string | null; confidence: Confidence }>, ctx: WriteContext = USER_WRITE): Promise<Skill> {
    const record: Record<string, unknown> = {};
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.domain !== undefined) record.domain = patch.domain;
    if (patch.description !== undefined) record.description = patch.description;
    if (patch.goal_id !== undefined) record.goal_id = patch.goal_id;
    if (patch.confidence !== undefined) record.confidence = patch.confidence;
    if (patch.weak_points !== undefined) record.weak_points = JSON.stringify(patch.weak_points);
    const updated = await this.repos.skills.update(id, record as never, { ...ctx, reason: 'skill updated' });
    if (!updated) throw AppError.notFound('skill', id);
    return updated;
  }

  async get(id: string): Promise<Skill | null> { return (await this.repos.skills.byId(id)) ?? null; }

  async view(id: string): Promise<SkillView | null> {
    const skill = await this.repos.skills.byId(id);
    if (!skill) return null;
    const assessments = await this.repos.skillAssessments.find({ skill_id: id }, { orderBy: { assessed_at: 'desc' }, limit: 50 });
    return {
      ...skill,
      weak_points_list: parseArray(skill.weak_points),
      evidence_list: parseJson(skill.evidence_json, []),
      assessments,
      days_to_next_assessment: skill.next_assessment_at ? daysUntil(skill.next_assessment_at) : null,
    };
  }

  async list(filter: { domain?: string } = {}): Promise<Skill[]> {
    return this.repos.skills.find(filter.domain ? { domain: filter.domain } : {}, { orderBy: { level: 'desc', updated_at: 'desc' }, limit: 500 });
  }

  /**
   * Evidence-based assessment. Requires evidence *or* a scored instrument;
   * refuses a bare "the AI thinks the level is X" (req. 41).
   */
  async assess(id: string, input: AssessSkillInput, ctx: WriteContext = USER_WRITE): Promise<{ skill: Skill; assessment: SkillAssessment; level_before: number; level_after: number; changed: boolean }> {
    const skill = await this.repos.skills.byId(id);
    if (!skill) throw AppError.notFound('skill', id);
    const parsed = AssessSkillSchema.parse(input);

    const hasEvidence = Boolean(parsed.evidence_ref || parsed.evidence_type);
    const hasScore = parsed.score !== null && parsed.score !== undefined;
    if (!hasEvidence && !hasScore) {
      throw AppError.validation(
        'A skill level can only change with evidence (project, test, practice, exam, task, explanation or a real result) or a scored assessment.',
      );
    }

    const levelBefore = Number(skill.level ?? 0);
    const levelAfter = clampLevel(parsed.level_after ?? (hasScore ? deriveLevel(levelBefore, Number(parsed.score), parsed.kind) : levelBefore));

    const assessment = await this.repos.skillAssessments.insert({
      id: newId('assessment'),
      skill_id: id,
      kind: parsed.kind,
      score: parsed.score ?? null,
      level_before: levelBefore,
      level_after: levelAfter,
      evidence_type: parsed.evidence_type ?? null,
      evidence_ref: parsed.evidence_ref ?? null,
      notes: parsed.notes ?? null,
      assessed_at: nowIso(),
      created_at: nowIso(),
    } as never, ctx);

    const evidenceList = parseJson<unknown[]>(skill.evidence_json, []);
    evidenceList.push({
      at: assessment.assessed_at, kind: parsed.kind, score: parsed.score ?? null,
      ref: parsed.evidence_ref ?? null, type: parsed.evidence_type ?? null, assessment_id: assessment.id,
    });

    const updated = await this.repos.skills.update(id, {
      level: levelAfter,
      confidence: (evidenceList.length >= 3 ? 'confirmed' : 'inferred') as Confidence,
      last_assessment_at: assessment.assessed_at,
      next_assessment_at: addDays(new Date(), this.intervalFor(levelAfter)).toISOString().slice(0, 10),
      evidence_json: JSON.stringify(evidenceList.slice(-50)),
    } as never, { ...ctx, reason: `assessed via ${parsed.kind}${parsed.score != null ? ` (score ${parsed.score})` : ''}` });

    // Evidence is also a memory: it explains *why* the model believes this level.
    await this.repos.memories.insert({
      id: newId('memory'),
      kind: 'skill_evidence',
      section: 'SKILLS',
      content: `${skill.name}: ${parsed.kind}${parsed.score != null ? ` scored ${parsed.score}/100` : ''} → level ${levelAfter}/100${parsed.evidence_ref ? ` (${parsed.evidence_ref})` : ''}`,
      importance: 0.6,
      confidence: 'confirmed',
      source: ctx.actor === 'user' ? 'user_provided' : 'system_observed',
      entity_type: 'skill',
      entity_id: id,
      tags: JSON.stringify(['skill', skill.name]),
      valid_from: assessment.assessed_at,
    } as never, ctx);

    return { skill: updated!, assessment, level_before: levelBefore, level_after: levelAfter, changed: levelAfter !== levelBefore };
  }

  /** Higher levels are re-checked less often; unused skills get a reminder, not a silent downgrade. */
  private intervalFor(level: number): number {
    if (level >= 85) return 180;
    if (level >= 65) return 120;
    if (level >= 40) return 75;
    if (level >= 15) return 45;
    return 30;
  }

  async dueForAssessment(asOf = new Date()): Promise<Skill[]> {
    const today = asOf.toISOString().slice(0, 10);
    const skills = await this.list();
    return skills.filter((s) => s.next_assessment_at && s.next_assessment_at <= today);
  }

  async addWeakPoint(id: string, point: string, ctx: WriteContext = USER_WRITE): Promise<Skill> {
    const skill = await this.repos.skills.byId(id);
    if (!skill) throw AppError.notFound('skill', id);
    const points = parseArray(skill.weak_points);
    if (!points.includes(point)) points.push(point);
    return this.update(id, { weak_points: points.slice(-30) }, ctx);
  }

  async removeWeakPoint(id: string, point: string, ctx: WriteContext = USER_WRITE): Promise<Skill> {
    const skill = await this.repos.skills.byId(id);
    if (!skill) throw AppError.notFound('skill', id);
    return this.update(id, { weak_points: parseArray(skill.weak_points).filter((p) => p !== point) }, ctx);
  }

  async remove(id: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const skill = await this.repos.skills.byId(id);
    if (!skill) return false;
    await this.repos.skills.softDelete(id, { ...ctx, reason: 'skill removed' });
    return true;
  }

  /** Skills relevant to the current goals/tasks — a small, targeted list for the AI context. */
  async relevantFor(goalIds: string[], limit = 6): Promise<Skill[]> {
    const skills = await this.list();
    const linked = skills.filter((s) => s.goal_id && goalIds.includes(s.goal_id));
    const rest = skills.filter((s) => !linked.includes(s));
    return [...linked, ...rest].slice(0, limit);
  }

  async contextText(limit = 8): Promise<string> {
    const skills = (await this.list()).slice(0, limit);
    return skills.map((s) => {
      const weak = parseArray(s.weak_points);
      return `- ${s.name}${s.domain ? ` (${s.domain})` : ''}: level ${s.level}/100 [${s.confidence}]${weak.length ? `, weak: ${weak.slice(0, 3).join(', ')}` : ''}`;
    }).join('\n');
  }
}

function parseArray(raw: string | null): string[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? value.map(String) : [];
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function clampLevel(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Derive a level from an assessment score, blended with the current level so one test
 * cannot swing a skill wildly (and a single bad day cannot erase years of practice).
 */
export function deriveLevel(currentLevel: number, score: number, kind: AssessmentKind): number {
  const weight = kind === 'exam' || kind === 'real_result' || kind === 'project' ? 0.5
    : kind === 'test' ? 0.35
      : kind === 'practice' ? 0.25
        : 0.2;
  return clampLevel(currentLevel * (1 - weight) + score * weight);
}
