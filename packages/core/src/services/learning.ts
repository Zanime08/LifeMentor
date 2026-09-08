import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { LearningPath, LearningProgress, LearningReview, LearningTopic } from '../domain/types';
import { newId } from '../util/id';
import { addDays, addMinutes, dayKey, nowIso } from '../util/time';
import { AppError } from '../util/result';

export const TopicInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).nullish(),
  outcome: z.string().trim().max(500).nullish(),
  estimated_minutes: z.number().int().min(5).max(8 * 60).default(45),
  depends_on: z.array(z.string()).max(20).default([]),
  resources: z.array(z.object({ title: z.string().max(200), url: z.string().max(500).nullish(), kind: z.string().max(40).nullish() })).max(20).default([]),
  cards: z.array(z.object({ key: z.string().max(80), prompt: z.string().max(500), answer: z.string().max(1000).nullish() })).max(40).default([]),
});
export type TopicInput = z.input<typeof TopicInput>;

export const CreatePathSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullish(),
  skill_id: z.string().nullish(),
  goal_id: z.string().nullish(),
  target_level: z.number().int().min(0).max(100).nullish(),
  topics: z.array(TopicInput).min(1).max(60),
});
export type CreatePathInput = z.input<typeof CreatePathSchema>;

export const RecordProgressSchema = z.object({
  topic_id: z.string(),
  kind: z.enum(['study', 'practice', 'test', 'recall', 'explanation', 'project']),
  minutes: z.number().int().min(0).max(12 * 60).default(0),
  score: z.number().min(0).max(100).nullish(),
  notes: z.string().max(2000).nullish(),
});
export type RecordProgressInput = z.input<typeof RecordProgressSchema>;

export interface PathView extends LearningPath {
  topics: (LearningTopic & { cards_due: number })[];
  due_reviews: number;
  total_minutes: number;
  done_minutes: number;
  skill_name: string | null;
}

/** SM-2 parameters (req. 39: active recall + spaced repetition). */
const MIN_EASE = 1.3;
const MASTERY_INTERVAL_DAYS = 60;

export function sm2(state: { interval_days: number; ease: number; repetitions: number; lapses: number }, quality: number) {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  let { interval_days: interval, ease, repetitions, lapses } = state;
  if (q < 3) {
    repetitions = 0;
    interval = 1;
    lapses += 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
  } else {
    repetitions += 1;
    interval = repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.max(1, Math.round(interval * ease));
    ease = Math.max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  }
  return { interval_days: interval, ease: Number(ease.toFixed(3)), repetitions, lapses };
}

/**
 * Learning engine (req. 38, 39): path → topics (with dependencies) → tasks → progress → reviews.
 * Progress recording drives topic %, path %, skill evidence and the spaced-repetition queue.
 */
export class LearningService {
  constructor(private readonly repos: Repos) {}

  async createPath(input: CreatePathInput, ctx: WriteContext = USER_WRITE): Promise<{ path: LearningPath; topics: LearningTopic[] }> {
    const parsed = CreatePathSchema.parse(input);
    if (parsed.skill_id && !(await this.repos.skills.byId(parsed.skill_id))) throw AppError.notFound('skill', parsed.skill_id);
    if (parsed.goal_id && !(await this.repos.goals.byId(parsed.goal_id))) throw AppError.notFound('goal', parsed.goal_id);

    const path = await this.repos.learningPaths.insert({
      id: newId('path'),
      title: parsed.title,
      description: parsed.description ?? null,
      skill_id: parsed.skill_id ?? null,
      goal_id: parsed.goal_id ?? null,
      target_level: parsed.target_level ?? null,
      status: 'active',
      progress: 0,
    } as never, { ...ctx, reason: 'learning path created' });

    const created: LearningTopic[] = [];
    let position = 0;
    for (const topic of parsed.topics) {
      const row = await this.repos.learningTopics.insert({
        id: newId('topic'),
        path_id: path.id,
        title: topic.title,
        summary: topic.summary ?? null,
        outcome: topic.outcome ?? null,
        position: position++,
        depends_on: JSON.stringify(topic.depends_on),
        estimated_minutes: topic.estimated_minutes,
        status: position === 1 ? 'available' : 'pending',
        resources_json: JSON.stringify(topic.resources),
        progress: 0,
        completed_at: null,
      } as never, ctx);
      created.push(row);

      for (const card of topic.cards) {
        await this.repos.learningReviews.insert({
          id: newId('review'),
          topic_id: row.id,
          card_key: card.key,
          prompt: card.prompt,
          answer: card.answer ?? null,
          due_at: nowIso(),
          interval_days: 0,
          ease: 2.5,
          repetitions: 0,
          lapses: 0,
          last_reviewed_at: null,
          status: 'active',
        } as never, ctx);
      }
    }
    return { path, topics: created };
  }

  async addTopic(pathId: string, input: TopicInput, ctx: WriteContext = USER_WRITE): Promise<LearningTopic> {
    if (!(await this.repos.learningPaths.byId(pathId))) throw AppError.notFound('learning path', pathId);
    const parsed = TopicInput.parse(input);
    const position = await this.repos.learningTopics.count({ path_id: pathId });
    const topic = await this.repos.learningTopics.insert({
      id: newId('topic'), path_id: pathId, title: parsed.title, summary: parsed.summary ?? null, outcome: parsed.outcome ?? null,
      position, depends_on: JSON.stringify(parsed.depends_on), estimated_minutes: parsed.estimated_minutes,
      status: position === 0 ? 'available' : 'pending', resources_json: JSON.stringify(parsed.resources), progress: 0, completed_at: null,
    } as never, ctx);
    for (const card of parsed.cards) await this.addCard(topic.id, card, ctx);
    return topic;
  }

  async addCard(topicId: string, card: { key: string; prompt: string; answer?: string | null }, ctx: WriteContext = USER_WRITE): Promise<LearningReview> {
    const existing = await this.repos.learningReviews.findOne({ topic_id: topicId, card_key: card.key });
    if (existing) return existing;
    return this.repos.learningReviews.insert({
      id: newId('review'), topic_id: topicId, card_key: card.key, prompt: card.prompt, answer: card.answer ?? null,
      due_at: nowIso(), interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, last_reviewed_at: null, status: 'active',
    } as never, ctx);
  }

  async updateTopic(id: string, patch: Partial<{ title: string; summary: string | null; outcome: string | null; estimated_minutes: number; status: LearningTopic['status']; position: number }>, ctx: WriteContext = USER_WRITE): Promise<LearningTopic> {
    const updated = await this.repos.learningTopics.update(id, patch as never, { ...ctx, reason: 'topic updated' });
    if (!updated) throw AppError.notFound('learning topic', id);
    await this.recomputePath(updated.path_id, ctx);
    return updated;
  }

  async completeTopic(id: string, ctx: WriteContext = USER_WRITE): Promise<LearningTopic> {
    const topic = await this.repos.learningTopics.byId(id);
    if (!topic) throw AppError.notFound('learning topic', id);
    const updated = await this.repos.learningTopics.update(id, { status: 'done', progress: 100, completed_at: nowIso() } as never, { ...ctx, reason: 'topic completed' });
    await this.unlockDependents(topic.path_id, id, ctx);
    await this.recomputePath(topic.path_id, ctx);
    return updated!;
  }

  /** Topics that only depended on completed topics become available. */
  private async unlockDependents(pathId: string, completedTopicId: string, ctx: WriteContext): Promise<void> {
    const topics = await this.repos.learningTopics.find({ path_id: pathId }, { orderBy: { position: 'asc' }, limit: 300 });
    const done = new Set(topics.filter((t) => t.status === 'done' || t.id === completedTopicId).map((t) => t.id));
    for (const topic of topics) {
      if (topic.status !== 'pending') continue;
      const deps: string[] = parseJson(topic.depends_on, []);
      if (deps.length === 0 || deps.every((d) => done.has(d))) {
        await this.repos.learningTopics.update(topic.id, { status: 'available' } as never, { ...ctx, reason: 'prerequisites completed', audit: true });
      }
    }
  }

  async recordProgress(input: RecordProgressInput, ctx: WriteContext = USER_WRITE): Promise<{ entry: LearningProgress; topic: LearningTopic; path: LearningPath }> {
    const parsed = RecordProgressSchema.parse(input);
    const topic = await this.repos.learningTopics.byId(parsed.topic_id);
    if (!topic) throw AppError.notFound('learning topic', parsed.topic_id);

    const entry = await this.repos.learningProgress.insert({
      id: newId(), topic_id: topic.id, path_id: topic.path_id, kind: parsed.kind,
      minutes: parsed.minutes, score: parsed.score ?? null, notes: parsed.notes ?? null, at: nowIso(), created_at: nowIso(),
    } as never, ctx);

    // Topic progress: weighted by time spent vs estimate, plus a completion boost for tests/practice.
    const entries = await this.repos.learningProgress.find({ topic_id: topic.id }, { limit: 1000 });
    const minutes = entries.reduce((acc, e) => acc + Number(e.minutes ?? 0), 0);
    const quality = entries.filter((e) => e.score !== null);
    const avgScore = quality.length ? quality.reduce((acc, e) => acc + Number(e.score), 0) / quality.length : null;
    const timeRatio = Math.min(1, minutes / Math.max(1, Number(topic.estimated_minutes)));
    const scoreRatio = avgScore !== null ? avgScore / 100 : 0;
    const progress = Math.round(Math.max(Number(topic.progress), Math.min(100, (timeRatio * 0.6 + scoreRatio * 0.4) * 100)));

    const status: LearningTopic['status'] = progress >= 100 ? 'done' : progress > 0 ? 'in_progress' : topic.status as LearningTopic['status'];
    const updatedTopic = await this.repos.learningTopics.update(topic.id, {
      progress,
      status,
      completed_at: status === 'done' && !topic.completed_at ? nowIso() : topic.completed_at,
    } as never, { ...ctx, reason: `progress recorded (${parsed.kind})` });

    if (status === 'done') await this.unlockDependents(topic.path_id, topic.id, ctx);
    const path = await this.recomputePath(topic.path_id, ctx);
    return { entry, topic: updatedTopic!, path };
  }

  async recomputePath(pathId: string, ctx: WriteContext = USER_WRITE): Promise<LearningPath> {
    const path = await this.repos.learningPaths.byId(pathId);
    if (!path) throw AppError.notFound('learning path', pathId);
    const topics = await this.repos.learningTopics.find({ path_id: pathId }, { limit: 300 });
    const weighted = topics.reduce((acc, t) => acc + Number(t.estimated_minutes ?? 45), 0);
    const done = topics.reduce((acc, t) => acc + (Number(t.estimated_minutes ?? 45) * Number(t.progress ?? 0)) / 100, 0);
    const progress = weighted > 0 ? Math.round((done / weighted) * 100) : 0;
    const status: LearningPath['status'] = progress >= 100 ? 'completed' : (path.status as LearningPath['status']);
    const updated = await this.repos.learningPaths.update(pathId, { progress, status } as never, { ...ctx, reason: 'path progress recomputed' });

    if (path.skill_id && progress > Number((await this.repos.skills.byId(path.skill_id))?.level ?? 0)) {
      // Progress alone is *not* enough for a level change — schedule an assessment instead.
      const skill = await this.repos.skills.byId(path.skill_id);
      if (skill && !skill.next_assessment_at) {
        await this.repos.skills.update(skill.id, { next_assessment_at: dayKey(addDays(new Date(), 7)) } as never, { ...ctx, reason: 'learning progress suggests an assessment' });
      }
    }
    return updated!;
  }

  async dueReviews(limit = 20, asOf = new Date()): Promise<(LearningReview & { topic_title: string; path_title: string })[]> {
    const rows = await this.repos.learningReviews.find(
      { status: 'active', due_at: { op: 'lte', value: asOf.toISOString() } },
      { orderBy: { due_at: 'asc' }, limit: limit * 3 },
    );
    const out: (LearningReview & { topic_title: string; path_title: string })[] = [];
    for (const review of rows.slice(0, limit)) {
      const topic = await this.repos.learningTopics.byId(review.topic_id, { includeDeleted: true });
      const path = topic ? await this.repos.learningPaths.byId(topic.path_id, { includeDeleted: true }) : null;
      out.push({ ...review, topic_title: topic?.title ?? 'Unknown topic', path_title: path?.title ?? 'Unknown path' });
    }
    return out;
  }

  async reviewsDueCount(asOf = new Date()): Promise<number> {
    return this.repos.learningReviews.count({ status: 'active', due_at: { op: 'lte', value: asOf.toISOString() } });
  }

  /** Grade a recall card 0..5 → SM-2 reschedule. */
  async gradeReview(reviewId: string, quality: number, ctx: WriteContext = USER_WRITE): Promise<LearningReview> {
    const review = await this.repos.learningReviews.byId(reviewId);
    if (!review) throw AppError.notFound('review card', reviewId);
    const next = sm2({ interval_days: Number(review.interval_days), ease: Number(review.ease), repetitions: Number(review.repetitions), lapses: Number(review.lapses) }, quality);
    const status: LearningReview['status'] = next.interval_days >= MASTERY_INTERVAL_DAYS ? 'mastered' : 'active';
    const updated = await this.repos.learningReviews.update(reviewId, {
      ...next,
      status,
      last_reviewed_at: nowIso(),
      due_at: addMinutes(new Date(), next.interval_days * 24 * 60).toISOString(),
    } as never, { ...ctx, reason: `review graded ${quality}/5` });

    await this.repos.learningProgress.insert({
      id: newId(), topic_id: review.topic_id, path_id: null, kind: 'recall', minutes: 2,
      score: (quality / 5) * 100, notes: `card ${review.card_key}`, at: nowIso(), created_at: nowIso(),
    } as never, ctx);
    return updated!;
  }

  async paths(filter: { status?: LearningPath['status'] } = {}): Promise<LearningPath[]> {
    return this.repos.learningPaths.find(filter.status ? { status: filter.status } : {}, { orderBy: { updated_at: 'desc' }, limit: 100 });
  }

  async pathView(id: string): Promise<PathView> {
    const path = await this.repos.learningPaths.byId(id);
    if (!path) throw AppError.notFound('learning path', id);
    const topics = await this.repos.learningTopics.find({ path_id: id }, { orderBy: { position: 'asc' }, limit: 300 });
    const skill = path.skill_id ? await this.repos.skills.byId(path.skill_id) : null;
    const withDue: (LearningTopic & { cards_due: number })[] = [];
    let dueTotal = 0;
    for (const topic of topics) {
      const due = await this.repos.learningReviews.count({ topic_id: topic.id, status: 'active', due_at: { op: 'lte', value: nowIso() } });
      dueTotal += due;
      withDue.push({ ...topic, cards_due: due });
    }
    const progressRows = await this.repos.learningProgress.find({ path_id: id }, { limit: 5000 });
    return {
      ...path,
      topics: withDue,
      due_reviews: dueTotal,
      total_minutes: topics.reduce((acc, t) => acc + Number(t.estimated_minutes ?? 0), 0),
      done_minutes: progressRows.reduce((acc, r) => acc + Number(r.minutes ?? 0), 0),
      skill_name: skill?.name ?? null,
    };
  }

  /** Study tasks for the planner: available topics + due reviews. */
  async nextActions(limit = 5): Promise<{ kind: 'topic' | 'review'; id: string; title: string; minutes: number; path_id: string; topic_id: string }[]> {
    const out: { kind: 'topic' | 'review'; id: string; title: string; minutes: number; path_id: string; topic_id: string }[] = [];
    const reviews = await this.dueReviews(limit);
    for (const r of reviews) out.push({ kind: 'review', id: r.id, title: `Recall: ${r.prompt.slice(0, 80)}`, minutes: 3, path_id: '', topic_id: r.topic_id });
    const topics = await this.repos.learningTopics.find({ status: { op: 'in', value: ['available', 'in_progress'] } }, { orderBy: { position: 'asc' }, limit: 50 });
    for (const t of topics) {
      if (out.length >= limit) break;
      out.push({ kind: 'topic', id: t.id, title: t.title, minutes: Number(t.estimated_minutes), path_id: t.path_id, topic_id: t.id });
    }
    return out.slice(0, limit);
  }

  async stats(): Promise<{ paths: number; active_paths: number; topics_done: number; topics_total: number; minutes_total: number; reviews_due: number; retention: number }> {
    const [paths, topics, progress] = await Promise.all([
      this.repos.learningPaths.find({}, { limit: 500 }),
      this.repos.learningTopics.find({}, { limit: 2000 }),
      this.repos.learningProgress.find({}, { limit: 20000 }),
    ]);
    const reviews = await this.repos.learningReviews.find({ status: { op: 'in', value: ['active', 'mastered'] } }, { limit: 5000 });
    const graded = reviews.filter((r) => r.repetitions > 0);
    const avgEase = graded.length ? graded.reduce((acc, r) => acc + Number(r.ease), 0) / graded.length : 2.5;
    return {
      paths: paths.length,
      active_paths: paths.filter((p) => p.status === 'active').length,
      topics_done: topics.filter((t) => t.status === 'done').length,
      topics_total: topics.length,
      minutes_total: progress.reduce((acc, p) => acc + Number(p.minutes ?? 0), 0),
      reviews_due: await this.reviewsDueCount(),
      retention: Number(((avgEase - MIN_EASE) / (2.5 - MIN_EASE)).toFixed(2)),
    };
  }

  async contextText(): Promise<string> {
    const active = await this.paths({ status: 'active' });
    if (!active.length) return '';
    const lines: string[] = [];
    for (const path of active.slice(0, 3)) {
      const view = await this.pathView(path.id);
      const next = view.topics.find((t) => t.status === 'available' || t.status === 'in_progress');
      lines.push(`- ${path.title}: ${Math.round(Number(path.progress))}%${view.skill_name ? `, skill ${view.skill_name}` : ''}${next ? `, next topic: ${next.title} (~${next.estimated_minutes}m)` : ''}${view.due_reviews ? `, ${view.due_reviews} recall cards due` : ''}`);
    }
    return lines.join('\n');
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
