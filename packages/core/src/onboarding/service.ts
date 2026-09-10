import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { GapType, Horizon, InterviewQuestion, OnboardingSession, OnboardingStage, Priority, ProfileSection } from '../domain/types';
import type { GoalService } from '../services/goals';
import type { SkillService } from '../services/skills';
import type { KnowledgeService } from '../services/knowledge';
import type { MemoryService } from '../services/memory';
import type { ProfileService, ProfileFieldInput } from '../services/profile';
import type { SettingsService } from '../services/settings';
import type { PlannerService } from '../planning/planner';
import type { DayPlan } from '../domain/types';
import { ALL_QUESTIONS, QUESTIONNAIRE, findQuestion, questionLabel, type Question, type QuestionBlock } from './questions';
import { detectGaps, mergeCandidates, selectQuestions, wakingHoursBetween, type AnswersMap, type GapCandidate, type InterviewAI } from './interview';
import { newId } from '../util/id';
import { addDays, dayKey, nowIso } from '../util/time';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';

export interface GoalDraft {
  title: string;
  description?: string | null;
  horizon: Horizon;
  priority: Priority;
  area?: string | null;
  motivation?: string | null;
  target_date?: string | null;
}

/** Optional AI assistance. Everything has a deterministic fallback — onboarding never dead-ends. */
export interface OnboardingAI extends InterviewAI {
  proposeGoals?(answers: AnswersMap, gaps: GapCandidate[]): Promise<GoalDraft[]>;
  /**
   * `null` means "no wording of your own — the deterministic summary is better". The built-in offline
   * engine answers every structured request with a generic template (a *day* summary, in English),
   * and it used to be shown on the confirmation screen as «вот как я вас понял»; only a real model
   * gets to word this screen now.
   */
  summariseModel?(model: ModelPreview): Promise<string | null>;
}

export interface OnboardingDeps {
  repos: Repos;
  settings: SettingsService;
  profile: ProfileService;
  goals: GoalService;
  skills: SkillService;
  knowledge: KnowledgeService;
  memory: MemoryService;
  planner: PlannerService;
  ai?: OnboardingAI;
}

export interface ModelPreviewItem {
  section: ProfileSection;
  key: string;
  label: string;
  value: unknown;
  source: 'user_provided' | 'ai_inferred' | 'system_observed';
  confidence: 'confirmed' | 'inferred' | 'uncertain';
  evidence: string;
}

export interface ModelPreview {
  items: ModelPreviewItem[];
  assumptions: ModelPreviewItem[];
  unknowns: string[];
  summary: string;
  settings_preview: Record<string, unknown>;
}

export interface OnboardingStatusView {
  session: OnboardingSession;
  stage: OnboardingStage;
  answered: number;
  total_questions: number;
  remaining_questions: string[];
  interview: { pending: number; answered: number };
  can_advance: boolean;
}

const MAX_INTERVIEW_QUESTIONS = 8;

/**
 * Onboarding (req. 1–4, 74, 75).
 *
 * Stage 1 questionnaire → analysis → Stage 2 adaptive interview → model preview →
 * user confirmation → initial goals / skills / knowledge seed / first plan → dashboard.
 * Every answer is committed immediately, so closing the app mid-onboarding resumes exactly
 * where the user stopped.
 */
export class OnboardingService {
  private readonly log = createLogger('onboarding');

  constructor(private readonly deps: OnboardingDeps) {}

  // ─────────────────────────── session ───────────────────────────
  async start(ctx: WriteContext = USER_WRITE): Promise<OnboardingSession> {
    const existing = await this.current();
    if (existing && existing.status !== 'completed' && existing.status !== 'abandoned') return existing;
    return this.deps.repos.onboardingSessions.insert({
      id: newId('session'), status: 'in_progress', stage: 'questionnaire', started_at: nowIso(),
      completed_at: null, answers_count: 0, model_json: null,
    } as never, { ...ctx, reason: 'onboarding started' });
  }

  async current(): Promise<OnboardingSession | null> {
    const session = await this.deps.repos.onboardingSessions.findOne(
      { status: { op: 'in', value: ['in_progress', 'awaiting_interview', 'awaiting_confirmation'] } },
      { orderBy: { started_at: 'desc' } },
    );
    return session ?? null;
  }

  async completedSession(): Promise<OnboardingSession | null> {
    return (await this.deps.repos.onboardingSessions.findOne({ status: 'completed' }, { orderBy: { completed_at: 'desc' } })) ?? null;
  }

  /**
   * The active session, or the last completed one. Reading the model, the answers or a
   * preview must keep working after onboarding finished — only `start()` opens a new session.
   */
  private async requireSession(): Promise<OnboardingSession> {
    const session = (await this.current()) ?? (await this.completedSession());
    if (!session) throw AppError.notFound('onboarding session');
    return session;
  }

  private async setStage(sessionId: string, stage: OnboardingStage, status?: OnboardingSession['status'], ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.deps.repos.onboardingSessions.update(sessionId, { stage, ...(status ? { status } : {}) } as never, { ...ctx, reason: `onboarding stage → ${stage}` });
  }

  async status(): Promise<OnboardingStatusView> {
    // Never start a new session just because the UI asked for status: a finished
    // onboarding must stay finished.
    const session = (await this.current()) ?? (await this.completedSession()) ?? (await this.start());
    const answers = await this.answers();
    const answeredKeys = new Set(Object.keys(answers));
    const remaining = ALL_QUESTIONS.filter((q) => q.critical && !answeredKeys.has(q.key)).map((q) => q.key);
    const interview = await this.deps.repos.interviewQuestions.find({ session_id: session.id }, { limit: 100 });
    return {
      session,
      stage: session.stage,
      answered: answeredKeys.size,
      total_questions: ALL_QUESTIONS.length,
      remaining_questions: remaining,
      interview: { pending: interview.filter((q) => q.status === 'pending' || q.status === 'asked').length, answered: interview.filter((q) => q.status === 'answered').length },
      can_advance: session.status === 'completed' || remaining.length === 0,
    };
  }

  blocks(): QuestionBlock[] { return QUESTIONNAIRE; }
  question(key: string): Question | undefined { return findQuestion(key); }

  // ─────────────────────────── stage 1: answers ───────────────────────────
  async answers(sessionId?: string): Promise<AnswersMap> {
    const session = sessionId ?? (await this.current())?.id ?? (await this.completedSession())?.id;
    if (!session) return {};
    const rows = await this.deps.repos.onboardingAnswers.find({ session_id: session }, { orderBy: { position: 'asc' }, limit: 500 });
    const out: AnswersMap = {};
    for (const row of rows) out[row.question_key] = decodeAnswer(row.answer, row.answer_kind);
    return out;
  }

  /** Persist one answer immediately (crash-safe resume, req. 94). */
  async answer(questionKey: string, value: unknown, ctx: WriteContext = USER_WRITE): Promise<{ saved: boolean; question: Question | null }> {
    // Answering implies the session exists — a deep link or a resumed install must not fail here.
    const session = (await this.current()) ?? (await this.start(ctx));
    const question = findQuestion(questionKey);
    const kind = question?.kind ?? (Array.isArray(value) ? 'multi' : typeof value === 'number' ? 'scale' : 'text');
    const encoded = JSON.stringify(value ?? null);
    const existing = await this.deps.repos.onboardingAnswers.findOne({ session_id: session.id, question_key: questionKey });
    if (existing) {
      await this.deps.repos.onboardingAnswers.update(existing.id, { answer: encoded, answer_kind: kind, updated_at: nowIso() } as never, ctx);
    } else {
      const position = await this.deps.repos.onboardingAnswers.count({ session_id: session.id });
      await this.deps.repos.onboardingAnswers.insert({
        id: newId(), session_id: session.id, block: question?.block ?? 'situation', question_key: questionKey,
        answer_kind: kind, answer: encoded, label: question?.prompt ?? null, source: 'user_provided', position,
        created_at: nowIso(), updated_at: nowIso(),
      } as never, ctx);
    }
    const count = await this.deps.repos.onboardingAnswers.count({ session_id: session.id });
    await this.deps.repos.onboardingSessions.update(session.id, { answers_count: count } as never, { ...ctx, audit: false });
    return { saved: true, question: question ?? null };
  }

  async answerBlock(values: Record<string, unknown>, ctx: WriteContext = USER_WRITE): Promise<number> {
    let saved = 0;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === '') continue;
      await this.answer(key, value, ctx);
      saved += 1;
    }
    return saved;
  }

  // ─────────────────────────── stage 2: adaptive interview ───────────────────────────
  /** Analyse the answers and decide what is worth asking (req. 3). */
  async analyse(ctx: WriteContext = USER_WRITE): Promise<{ gaps: GapCandidate[]; selected: GapCandidate[]; session: OnboardingSession }> {
    const session = await this.requireSession();
    const answers = await this.answers(session.id);
    const deterministic = detectGaps(answers);

    let aiProposed: GapCandidate[] = [];
    if (this.deps.ai?.proposeQuestions) {
      try { aiProposed = await this.deps.ai.proposeQuestions({ answers, gaps: deterministic }); } catch (error) {
        this.log.warn('AI question proposal failed — using deterministic gaps only', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const asked = await this.deps.repos.interviewQuestions.find({ session_id: session.id }, { limit: 100 });
    const askedTargets = asked.map((q) => q.target ?? '');
    const selected = selectQuestions(mergeCandidates(deterministic, aiProposed, 12), {
      max: MAX_INTERVIEW_QUESTIONS,
      askedTargets,
      answeredTargets: asked.filter((q) => q.status === 'answered').map((q) => q.target ?? ''),
    });

    for (const candidate of selected) {
      const exists = asked.find((q) => q.target === candidate.target && q.status === 'pending');
      if (exists) continue;
      await this.deps.repos.interviewQuestions.insert({
        id: newId(), session_id: session.id, gap_type: candidate.gap_type, target: candidate.target,
        question: candidate.question, rationale: candidate.rationale, importance: candidate.importance,
        status: 'pending', answer: null, changed_model: 0, asked_at: null, answered_at: null,
      } as never, ctx);
    }
    await this.setStage(session.id, 'interview', 'awaiting_interview', ctx);
    this.log.info('onboarding analysis complete', { deterministic: deterministic.length, ai: aiProposed.length, selected: selected.length });
    return { gaps: deterministic, selected, session };
  }

  async pendingInterviewQuestions(limit = MAX_INTERVIEW_QUESTIONS): Promise<InterviewQuestion[]> {
    const session = await this.requireSession();
    return this.deps.repos.interviewQuestions.find(
      { session_id: session.id, status: { op: 'in', value: ['pending', 'asked'] } },
      { orderBy: { importance: 'desc' }, limit },
    );
  }

  async markAsked(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.deps.repos.interviewQuestions.update(id, { status: 'asked', asked_at: nowIso() } as never, ctx);
  }

  /**
   * Record an interview answer. The answer is folded into the answer map and the detectors run
   * again, so the interview adapts within the session instead of asking a fixed script.
   */
  async answerInterview(id: string, answer: string, ctx: WriteContext = USER_WRITE): Promise<{ question: InterviewQuestion; followUps: GapCandidate[] }> {
    const session = await this.requireSession();
    const question = await this.deps.repos.interviewQuestions.byId(id);
    if (!question) throw AppError.notFound('interview question', id);

    const updated = await this.deps.repos.interviewQuestions.update(id, { status: 'answered', answer, answered_at: nowIso(), changed_model: 1 } as never, { ...ctx, reason: 'interview answered' });
    await this.deps.repos.onboardingAnswers.insert({
      id: newId(), session_id: session.id, block: 'interview', question_key: `interview:${question.target ?? question.id}`,
      answer_kind: 'text', answer: JSON.stringify(answer), label: question.question, source: 'user_provided',
      position: 900 + Number(question.importance * 100), created_at: nowIso(), updated_at: nowIso(),
    } as never, ctx).catch(async () => {
      const existing = await this.deps.repos.onboardingAnswers.findOne({ session_id: session.id, question_key: `interview:${question.target ?? question.id}` });
      if (existing) await this.deps.repos.onboardingAnswers.update(existing.id, { answer: JSON.stringify(answer), updated_at: nowIso() } as never, ctx);
    });

    const answers = await this.answers(session.id);
    const answeredTargets = (await this.deps.repos.interviewQuestions.find({ session_id: session.id, status: 'answered' }, { limit: 100 })).map((q) => q.target ?? '');
    const followUps = selectQuestions(detectGaps(answers), { max: 2, minImportance: 0.7, askedTargets: answeredTargets, answeredTargets });
    for (const candidate of followUps) {
      await this.deps.repos.interviewQuestions.insert({
        id: newId(), session_id: session.id, gap_type: candidate.gap_type, target: candidate.target, question: candidate.question,
        rationale: candidate.rationale, importance: candidate.importance * 0.9, status: 'pending', answer: null,
        changed_model: 0, asked_at: null, answered_at: null,
      } as never, ctx);
    }
    return { question: updated ?? { ...question, status: 'answered', answer, answered_at: nowIso() }, followUps };
  }

  async skipInterview(id: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    await this.deps.repos.interviewQuestions.update(id, { status: 'skipped', answered_at: nowIso() } as never, { ...ctx, reason: 'user skipped the question' });
  }

  async finishInterview(ctx: WriteContext = USER_WRITE): Promise<void> {
    const session = await this.requireSession();
    const pending = await this.pendingInterviewQuestions();
    for (const question of pending) await this.skipInterview(question.id, ctx);
    await this.setStage(session.id, 'confirmation', 'awaiting_confirmation', ctx);
  }

  // ─────────────────────────── model preview & confirmation ───────────────────────────
  /** "Here is how I understood you." — built from answers only; nothing is stored yet. */
  async previewModel(): Promise<ModelPreview> {
    const session = await this.requireSession();
    const answers = await this.answers(session.id);
    const interview = await this.deps.repos.interviewQuestions.find({ session_id: session.id, status: 'answered' }, { limit: 100 });
    const items = buildModelItems(answers, interview);
    const assumptions = items.filter((i) => i.source === 'ai_inferred' || i.confidence !== 'confirmed');
    const unknowns = detectGaps(answers).filter((g) => g.importance >= 0.7).map((g) => g.target);
    const settingsPreview = settingsFromAnswers(answers, await this.language());

    let summary = heuristicSummary(answers, items, await this.language());
    if (this.deps.ai?.summariseModel) {
      try {
        const aiSummary = await this.deps.ai.summariseModel({ items, assumptions, unknowns, summary, settings_preview: settingsPreview });
        if (aiSummary) summary = aiSummary;
      } catch { /* keep the deterministic summary */ }
    }
    return { items, assumptions, unknowns, summary, settings_preview: settingsPreview };
  }

  /**
   * Confirm (optionally with edits) → write profile fields, settings, memories, snapshot.
   * Only after this does the system generate the initial strategy (req. 75).
   */
  async confirmModel(edits: { items?: { section: ProfileSection; key: string; value: unknown }[]; removed?: { section: ProfileSection; key: string }[] } = {}, ctx: WriteContext = USER_WRITE): Promise<{ fields: number; snapshot_id: string }> {
    const session = await this.requireSession();
    const preview = await this.previewModel();
    const answers = await this.answers(session.id);

    const removed = new Set((edits.removed ?? []).map((r) => `${r.section}.${r.key}`));
    const edited = new Map((edits.items ?? []).map((e) => [`${e.section}.${e.key}`, e.value]));

    const fields: ProfileFieldInput[] = [];
    for (const item of preview.items) {
      const id = `${item.section}.${item.key}`;
      if (removed.has(id)) continue;
      const value = edited.has(id) ? edited.get(id) : item.value;
      fields.push({
        section: item.section, key: item.key, label: item.label, value,
        source: edited.has(id) ? 'user_provided' : item.source,
        confidence: edited.has(id) ? 'confirmed' : item.confidence,
        evidence: item.evidence,
        importance: importanceFor(item.section),
      });
    }
    for (const [id, value] of edited) {
      if (fields.some((f) => `${f.section}.${f.key}` === id)) continue;
      const [section, ...rest] = id.split('.');
      fields.push({ section: section as ProfileSection, key: rest.join('.'), value, source: 'user_provided', confidence: 'confirmed', evidence: 'user edit at confirmation' });
    }

    await this.deps.profile.setMany(fields, { ...ctx, reason: 'onboarding confirmed' });
    await this.deps.settings.setMany(settingsFromAnswers(answers, await this.language()) as never, ctx);

    // Facts the user stated become long-term memories too (they outlive the onboarding session).
    for (const item of fields.filter((f) => f.source === 'user_provided' && f.confidence === 'confirmed').slice(0, 40)) {
      await this.deps.memory.save({
        kind: item.section === 'PREFERENCES' || item.section === 'LEARNING_PREFERENCES' ? 'preference' : 'fact',
        content: `${item.label ?? item.key}: ${renderValue(item.value)}`,
        section: item.section,
        importance: importanceFor(item.section),
        source: 'user_provided',
        confidence: 'confirmed',
        tags: ['onboarding', item.section.toLowerCase()],
        provenance: [{ source_type: 'onboarding', source_id: session.id }],
      }, ctx);
    }

    const snapshot = await this.deps.profile.snapshot('onboarding_confirmed');
    await this.deps.repos.onboardingSessions.update(session.id, { model_json: JSON.stringify(preview), stage: 'goals' } as never, { ...ctx, reason: 'user model confirmed' });
    await this.deps.settings.set('flags', { user_model_confirmed: true }, ctx);
    return { fields: fields.length, snapshot_id: snapshot.id };
  }

  /** The language the user reads in: the AI setting, then the profile locale, then English. */
  private async language(): Promise<string> {
    try {
      const all = await this.deps.settings.all();
      return all.ai.language || all.profile.locale || 'en';
    } catch {
      return 'en';
    }
  }

  // ─────────────────────────── initial goals / skills / knowledge / plan ───────────────────────────
  /** Draft goals derived from what the user actually said — the user confirms each one. */
  async suggestGoals(): Promise<GoalDraft[]> {
    const session = await this.requireSession();
    const answers = await this.answers(session.id);
    if (this.deps.ai?.proposeGoals) {
      try {
        const drafts = await this.deps.ai.proposeGoals(answers, detectGaps(answers));
        if (drafts?.length) return drafts.slice(0, 8);
      } catch (error) {
        this.log.warn('AI goal proposal failed — using heuristic drafts', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return heuristicGoals(answers, await this.language());
  }

  async createGoals(drafts: GoalDraft[], ctx: WriteContext = USER_WRITE): Promise<{ created: number; ids: string[] }> {
    const ids: string[] = [];
    for (const draft of drafts) {
      if (!draft.title?.trim()) continue;
      const goal = await this.deps.goals.create({
        title: draft.title.trim(),
        description: draft.description ?? null,
        horizon: draft.horizon,
        priority: draft.priority,
        area: draft.area ?? null,
        motivation: draft.motivation ?? null,
        target_date: draft.target_date ?? null,
      }, { ...ctx, reason: 'initial goal from onboarding' });
      ids.push(goal.id);
    }
    const session = await this.current();
    if (session) await this.setStage(session.id, 'skills', undefined, ctx);
    return { created: ids.length, ids };
  }

  /** Skill map from stated skills; every level starts `uncertain` until evidence exists (req. 41). */
  async createInitialSkills(ctx: WriteContext = USER_WRITE): Promise<{ created: number }> {
    const session = await this.requireSession();
    const answers = await this.answers(session.id);
    const proof = String(answers.proof_of_skill ?? '').trim();
    let created = 0;

    const have = splitList(answers.skills_have);
    const learning = splitList(answers.skills_learning);
    const want = splitList(answers.skills_want);

    for (const name of have) {
      const evidence = proof && proof.toLowerCase().includes(name.toLowerCase().split(' ')[0] ?? '') ? proof : null;
      const skill = await this.deps.skills.create({
        name, domain: guessDomain(name, answers), level: 0, self_rating: null,
        description: 'From onboarding: stated as an existing skill',
      }, { ...ctx, reason: 'initial skill (stated)' }).catch(() => null);
      if (!skill) continue;
      created += 1;
      if (evidence) {
        await this.deps.skills.assess(skill.id, { kind: 'real_result', evidence_type: 'onboarding_evidence', evidence_ref: evidence, notes: 'Stated during onboarding', score: null, level_after: null }, ctx);
      }
    }
    for (const name of [...learning, ...want]) {
      const exists = await this.deps.skills.create({
        name, domain: guessDomain(name, answers), level: 0, self_rating: null,
        description: learning.includes(name) ? 'From onboarding: currently learning' : 'From onboarding: wants to master',
      }, { ...ctx, reason: 'initial skill (target)' }).catch(() => null);
      if (exists) created += 1;
    }

    const goals = await this.deps.goals.list({ status: 'active' });
    const topGoal = goals[0];
    if (topGoal && want.length) {
      const primary = await this.deps.skills.list().then((s) => s.find((x) => x.name.toLowerCase() === want[0].toLowerCase()));
      if (primary) await this.deps.skills.update(primary.id, { goal_id: topGoal.id }, ctx);
    }
    await this.setStage(session.id, 'plan', undefined, ctx);
    return { created };
  }

  async seedKnowledge(ctx: WriteContext = USER_WRITE): Promise<number> {
    const session = await this.requireSession();
    const answers = await this.answers(session.id);
    const interests = [...splitList(answers.interests), ...splitList(answers.interests_other)];
    const skills = (await this.deps.skills.list()).map((s) => ({ name: s.name, domain: s.domain, level: Number(s.level) }));
    const created = await this.deps.knowledge.seedFromProfile(interests.slice(0, 10), skills.slice(0, 15), ctx);
    return created;
  }

  async createInitialPlan(ctx: WriteContext = USER_WRITE): Promise<DayPlan> {
    const session = await this.requireSession();
    const plan = await this.deps.planner.buildDay(dayKey(), { dryRun: false });
    await this.setStage(session.id, 'done', undefined, ctx);
    await this.complete(ctx);
    return plan;
  }

  async complete(ctx: WriteContext = USER_WRITE): Promise<void> {
    const session = await this.current();
    if (!session) return;
    await this.deps.repos.onboardingSessions.update(session.id, { status: 'completed', completed_at: nowIso(), stage: 'done' } as never, { ...ctx, reason: 'onboarding completed' });
    await this.deps.settings.set('flags', { onboarding_completed: true, first_plan_generated: true }, ctx);
  }

  async abandon(ctx: WriteContext = USER_WRITE): Promise<void> {
    const session = await this.current();
    if (!session) return;
    await this.deps.repos.onboardingSessions.update(session.id, { status: 'abandoned' } as never, { ...ctx, reason: 'onboarding abandoned' });
  }
}

// ─────────────────────────── pure model-building helpers ───────────────────────────
function decodeAnswer(raw: string, kind: string): unknown {
  try {
    const value = JSON.parse(raw);
    if (kind === 'scale' || kind === 'number') return typeof value === 'number' ? value : Number(value);
    return value;
  } catch { return raw; }
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[,\n;]/).map((s) => s.trim()).filter((s) => s.length > 1);
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function importanceFor(section: ProfileSection): number {
  switch (section) {
    case 'GOALS': case 'CAREER_DIRECTION': case 'FINANCIAL_DIRECTION': return 0.95;
    case 'CONSTRAINTS': case 'TIME_AVAILABILITY': return 0.9;
    case 'SKILLS': case 'PREFERENCES': return 0.8;
    case 'INTERESTS': case 'MOTIVATION_FACTORS': return 0.7;
    case 'DISTRACTIONS': case 'LEARNING_PREFERENCES': return 0.65;
    default: return 0.55;
  }
}

/** Map questionnaire answers onto the 15 model sections, with source + confidence per item. */
export function buildModelItems(answers: AnswersMap, interview: { target: string | null; question: string; answer: string | null }[]): ModelPreviewItem[] {
  const items: ModelPreviewItem[] = [];
  const push = (section: ProfileSection, key: string, label: string, value: unknown, evidence: string, source: ModelPreviewItem['source'] = 'user_provided', confidence: ModelPreviewItem['confidence'] = 'confirmed') => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    items.push({ section, key, label, value, source, confidence, evidence });
  };

  push('PROFILE', 'age_category', 'Age range', labelOf(answers.age_category, 'age_category'), 'questionnaire: age_category');
  push('PROFILE', 'education', 'Education', labelOf(answers.education, 'education'), 'questionnaire: education');
  push('PROFILE', 'main_activity', 'Current activity', labelsOf(answers.main_activity, 'main_activity'), 'questionnaire: main_activity');
  push('PROFILE', 'family_situation', 'Living situation', labelOf(answers.family_situation, 'family_situation'), 'questionnaire: family_situation');
  push('PROFILE', 'energy_pattern', 'Sharpest time of day', labelOf(answers.energy_pattern, 'energy_pattern'), 'questionnaire: energy_pattern');

  push('GOALS', 'primary', 'What you want to achieve', answers.what_you_want, 'questionnaire: what_you_want');
  push('GOALS', 'avoid', 'What you want to avoid', answers.what_to_avoid, 'questionnaire: what_to_avoid');
  push('VALUES', 'identity', 'Who you want to become', answers.who_to_become, 'questionnaire: who_to_become');
  push('GOALS', 'problems', 'Problems to solve first', answers.problems_to_solve, 'questionnaire: problems_to_solve');
  push('GOALS', 'horizon', 'Expected first result', labelOf(answers.goal_horizon, 'goal_horizon'), 'questionnaire: goal_horizon');

  push('SKILLS', 'current', 'Skills you already have', splitList(answers.skills_have), 'questionnaire: skills_have');
  push('SKILLS', 'learning', 'Currently learning', splitList(answers.skills_learning), 'questionnaire: skills_learning');
  push('SKILLS', 'targets', 'Want to master', splitList(answers.skills_want), 'questionnaire: skills_want');
  push('SKILLS', 'evidence', 'Real evidence of skill', answers.proof_of_skill, 'questionnaire: proof_of_skill');

  push('INTERESTS', 'areas', 'Interests', labelsOf(answers.interests, 'interests'), 'questionnaire: interests');
  push('INTERESTS', 'other', 'Other interests', answers.interests_other, 'questionnaire: interests_other');
  push('MOTIVATION_FACTORS', 'curiosity', 'Could talk for hours about', answers.curiosity, 'questionnaire: curiosity');

  push('TIME_AVAILABILITY', 'wake_time', 'Usual wake time', answers.wake_time, 'questionnaire: wake_time');
  push('TIME_AVAILABILITY', 'sleep_time', 'Usual sleep time', answers.sleep_time, 'questionnaire: sleep_time');
  push('TIME_AVAILABILITY', 'typical_day', 'Typical day', answers.typical_day, 'questionnaire: typical_day');
  push('CONSTRAINTS', 'fixed_hours_per_day', 'Fixed hours per day', answers.fixed_hours_per_day, 'questionnaire: fixed_hours_per_day');
  push('TIME_AVAILABILITY', 'available_hours_per_day', 'Hours available for development', answers.available_hours_per_day, 'questionnaire: available_hours_per_day');
  push('CONSTRAINTS', 'disruptions', 'What breaks your plans', answers.obligations, 'questionnaire: obligations');
  push('DISTRACTIONS', 'main', 'Main distractions', labelsOf(answers.distractions, 'distractions'), 'questionnaire: distractions');

  push('PREFERENCES', 'planning_style', 'Planning style', labelOf(answers.planning_style, 'planning_style'), 'questionnaire: planning_style');
  push('PREFERENCES', 'strictness', 'How firmly to push', answers.strictness, 'questionnaire: strictness');
  push('PREFERENCES', 'free_time_desired_hours', 'Free time to protect (h/day)', answers.free_time_desired, 'questionnaire: free_time_desired');
  push('PREFERENCES', 'reminder_attitude', 'Attitude to reminders', labelOf(answers.reminder_attitude, 'reminder_attitude'), 'questionnaire: reminder_attitude');
  push('PREFERENCES', 'past_failures', 'What failed before', answers.planning_history, 'questionnaire: planning_history');

  push('CAREER_DIRECTION', 'wants', 'Career direction', labelsOf(answers.career_direction, 'career_direction'), 'questionnaire: career_direction');
  push('FINANCIAL_DIRECTION', 'situation', 'Financial situation', labelOf(answers.financial_situation, 'financial_situation'), 'questionnaire: financial_situation');
  push('FINANCIAL_DIRECTION', 'risk_tolerance', 'Risk tolerance (1-5)', answers.risk_tolerance, 'questionnaire: risk_tolerance');
  push('FINANCIAL_DIRECTION', 'capital_available', 'Capital available', answers.capital_available, 'questionnaire: capital_available');
  push('FINANCIAL_DIRECTION', 'definition_of_earning_well', 'What "earning well" means', answers.income_expectation, 'questionnaire: income_expectation');

  // Derived (AI-inferred) items — always flagged as assumptions.
  const fixed = Number(answers.fixed_hours_per_day ?? 0);
  const available = Number(answers.available_hours_per_day ?? 0);
  const waking = answers.wake_time && answers.sleep_time ? wakingHoursBetween(String(answers.wake_time), String(answers.sleep_time)) : null;
  if (waking !== null && fixed > 0) {
    push('TIME_AVAILABILITY', 'realistic_daily_focus_minutes', 'Realistic daily focus (minutes)',
      Math.max(0, Math.round(Math.min(available, waking - fixed - 2.5 - Number(answers.free_time_desired ?? 1.5)) * 60)),
      'derived from your hours, sleep and free-time request', 'ai_inferred', 'inferred');
  }
  if (answers.energy_pattern && answers.energy_pattern !== 'variable') {
    push('LEARNING_PREFERENCES', 'best_focus_window', 'Best focus window',
      answers.energy_pattern === 'morning' ? 'first 3 hours after waking' : answers.energy_pattern === 'night' ? 'late evening' : 'afternoon/evening',
      'derived from your stated energy pattern', 'ai_inferred', 'inferred');
  }
  const learningStyle = inferLearningPreferences(answers);
  if (learningStyle.length) push('LEARNING_PREFERENCES', 'formats', 'Likely suitable formats', learningStyle, 'derived from activity, interests and evidence', 'ai_inferred', 'uncertain');

  // Interview answers refine or override the model.
  for (const entry of interview) {
    if (!entry.answer || !entry.target) continue;
    const [sectionRaw, ...keyParts] = entry.target.split('.');
    const section = (PROFILE_SECTIONS_SET.has(sectionRaw) ? sectionRaw : 'GOALS') as ProfileSection;
    const key = keyParts.join('.') || 'clarification';
    push(section, key, `Clarification: ${entry.question.slice(0, 60)}${entry.question.length > 60 ? '…' : ''}`, entry.answer, `interview: ${entry.question}`);
  }
  return items;
}

const PROFILE_SECTIONS_SET = new Set([
  'PROFILE', 'VALUES', 'GOALS', 'CONSTRAINTS', 'INTERESTS', 'SKILLS', 'KNOWLEDGE', 'PROJECTS',
  'PREFERENCES', 'TIME_AVAILABILITY', 'MOTIVATION_FACTORS', 'DISTRACTIONS', 'LEARNING_PREFERENCES',
  'CAREER_DIRECTION', 'FINANCIAL_DIRECTION',
]);

function labelOf(value: unknown, questionKey: string): unknown {
  if (value === undefined || value === null || value === '') return null;
  return questionLabel(questionKey, value);
}
function labelsOf(value: unknown, questionKey: string): unknown {
  const list = splitList(value);
  if (!list.length) return null;
  return questionLabel(questionKey, list);
}

function inferLearningPreferences(answers: AnswersMap): string[] {
  const out: string[] = [];
  const activities = splitList(answers.main_activity);
  const interests = splitList(answers.interests);
  if (activities.includes('study') || activities.includes('academia')) out.push('structured courses');
  if (answers.proof_of_skill) out.push('project-based practice');
  if (interests.includes('programming') || interests.includes('technology')) out.push('hands-on building', 'documentation reading');
  if (interests.includes('languages')) out.push('daily short practice', 'speaking practice');
  if (interests.includes('sport') || interests.includes('health')) out.push('short daily sessions');
  if (Number(answers.available_hours_per_day ?? 0) <= 1) out.push('micro-sessions (15-25 min)');
  return [...new Set(out)].slice(0, 5);
}

function guessDomain(skill: string, answers: AnswersMap): string | null {
  const interests = splitList(answers.interests).map((i) => i.toLowerCase());
  const lower = skill.toLowerCase();
  if (/(python|java|javascript|typescript|sql|c\+\+|go\b|rust|react|backend|frontend|devops|git)/.test(lower)) return 'programming';
  if (/(english|spanish|german|french|chinese|language)/.test(lower)) return 'languages';
  if (/(sales|marketing|business|management|product|negotiation)/.test(lower)) return 'business';
  if (/(invest|finance|trading|accounting|budget)/.test(lower)) return 'finance';
  if (/(design|draw|music|guitar|piano|write|photo|video)/.test(lower)) return 'creativity';
  if (/(fitness|run|swim|yoga|sport)/.test(lower)) return 'health';
  return interests[0] ?? null;
}

/** Turn answers into concrete settings groups (applied on confirmation). */
export function settingsFromAnswers(answers: AnswersMap, language = 'en'): Record<string, Record<string, unknown>> {
  const style = String(answers.planning_style ?? 'balanced');
  const strictness = Number(answers.strictness ?? 5) / 10;
  const freeHours = Number(answers.free_time_desired ?? 1.5);
  const available = Number(answers.available_hours_per_day ?? 2);
  const wake = /^\d{2}:\d{2}$/.test(String(answers.wake_time ?? '')) ? String(answers.wake_time) : '07:30';
  const sleep = /^\d{2}:\d{2}$/.test(String(answers.sleep_time ?? '')) ? String(answers.sleep_time) : '23:30';

  return {
    planning: {
      style: ['strict', 'balanced', 'flexible'].includes(style) ? style : 'balanced',
      strictness: Math.max(0, Math.min(1, strictness)),
      free_time_minutes: Math.round(Math.max(0, Math.min(8, freeHours)) * 60),
      max_focus_hours_per_day: Math.max(0.5, Math.min(12, available)),
      wake_time: wake,
      sleep_time: sleep,
      reminder_style: String(answers.reminder_attitude ?? 'gentle'),
    },
    learning: { daily_minutes: Math.round(Math.max(0, Math.min(10, available)) * 60 * 0.6) || 45 },
    news: { categories: newsCategoriesFromInterests(splitList(answers.interests)) },
    // The language the client already decided for this user (see the web bootstrap) — onboarding
    // must not silently switch them to English, which is what a hardcoded 'en' did.
    ai: { language },
  };
}

function newsCategoriesFromInterests(interests: string[]): string[] {
  const map: Record<string, string> = {
    technology: 'technology', programming: 'programming', ai: 'ai', science: 'science',
    business: 'business', finance: 'economy', history: 'world', philosophy: 'science', health: 'science',
  };
  const out = new Set<string>(['world']);
  for (const interest of interests) if (map[interest.toLowerCase()]) out.add(map[interest.toLowerCase()]);
  return [...out].slice(0, 6);
}

/**
 * «Вот как я вас понял» — the sentence at the top of the confirmation step (req. 7).
 *
 * This is text the *user* reads, not an internal string, so it is written in their language from the
 * start: the language comes from the settings the client configured for them (the app is Russian for
 * a Russian user, English otherwise). `items` decides the last sentence — assumptions are called out.
 */
function heuristicSummary(answers: AnswersMap, items: ModelPreviewItem[], language = 'en'): string {
  const goals = String(answers.what_you_want ?? '').trim();
  const skills = splitList(answers.skills_want);
  const career = labelsOf(answers.career_direction, 'career_direction');
  const available = Number(answers.available_hours_per_day ?? 0);
  const fixed = Number(answers.fixed_hours_per_day ?? 0);
  const assumptions = items.filter((i) => i.source === 'ai_inferred');
  const ru = language.toLowerCase().startsWith('ru');

  const parts: string[] = [];
  if (ru) {
    parts.push(goals ? `Вы хотите: ${goals}.` : 'Главной цели вы пока не назвали — это нормально, уточним по ходу.');
    if (skills.length) parts.push(`Хотите освоить: ${skills.slice(0, 4).join(', ')}.`);
    if (career) parts.push(`Направление: ${renderValue(career)}.`);
    if (available) parts.push(`На это есть ~${available} ч в день, из них ${fixed} ч уже занято.`);
    if (assumptions.length) parts.push(`Ниже ${assumptions.length} ${pluralRu(assumptions.length, 'пункт — моё предположение', 'пункта — мои предположения', 'пунктов — мои предположения')}: поправьте, если не так.`);
    return parts.join(' ');
  }
  parts.push(goals ? `You want: ${goals}.` : 'You have not told me a main goal yet.');
  if (skills.length) parts.push(`You want to master ${skills.slice(0, 4).join(', ')}.`);
  if (career) parts.push(`Direction: ${renderValue(career)}.`);
  if (available) parts.push(`You have ~${available}h/day for this, with ${fixed}h already fixed.`);
  if (assumptions.length) parts.push(`${assumptions.length} item(s) below are my assumptions — correct any of them.`);
  return parts.join(' ');
}

/** Russian plural for the few sentences the engine composes for the user. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Deterministic goal drafts from the user's own words (the AI can improve on this). */
export function heuristicGoals(answers: AnswersMap, language = 'en'): GoalDraft[] {
  const drafts: GoalDraft[] = [];
  const horizon: Horizon = horizonFromAnswer(String(answers.goal_horizon ?? ''));
  const targetDate = targetDateFor(horizon);
  const raw = String(answers.what_you_want ?? '');
  const clauses = raw.split(/[.;\n]| and then |, and /i).map((s) => s.trim()).filter((s) => s.length > 8);
  const ru = language.toLowerCase().startsWith('ru');

  clauses.slice(0, 4).forEach((clause, index) => {
    drafts.push({
      title: capitalize(clause.replace(/^(i want to|i want|i need to|i would like to|хочу|я хочу)\s+/i, '')),
      description: ru ? `Из знакомства: «${clause}»` : `From onboarding: "${clause}"`,
      horizon,
      priority: index === 0 ? 'P1' : 'P2',
      area: guessArea(clause, answers),
      motivation: raw.slice(0, 200),
      target_date: targetDate,
    });
  });

  for (const skill of splitList(answers.skills_want).slice(0, 2)) {
    drafts.push({
      // The goal title is the user's own data — it is created in their language, not in the engine's.
      title: ru ? `Освоить ${skill} до рабочего уровня` : `Learn ${skill} to a usable level`,
      description: ru ? 'Из знакомства: навыки, которые вы хотите освоить' : 'From onboarding: skills you want to master',
      horizon: 'medium',
      priority: drafts.length ? 'P2' : 'P1',
      area: guessDomain(skill, answers) ?? 'learning',
      target_date: targetDateFor('medium'),
    });
  }

  const avoid = String(answers.what_to_avoid ?? '').trim();
  if (avoid.length > 5) {
    drafts.push({
      title: ru ? `Сократить: ${capitalize(avoid.slice(0, 80))}` : `Reduce: ${capitalize(avoid.slice(0, 80))}`,
      description: ru ? 'Из знакомства: то, чего вы хотите избегать' : 'From onboarding: what you want to avoid',
      horizon: 'short', priority: 'P2', area: 'lifestyle', target_date: targetDateFor('short'),
    });
  }
  if (!drafts.length) {
    drafts.push({
      title: ru ? 'Определить, чего я на самом деле хочу в ближайшие 3 месяца' : 'Define what I actually want in the next 3 months',
      description: ru ? 'Создано потому, что на знакомстве не прозвучало конкретной цели.' : 'Created because no concrete goal was given during onboarding.',
      horizon: 'short', priority: 'P1', area: 'clarity', target_date: targetDateFor('short'),
    });
  }
  return drafts.slice(0, 6);
}

function horizonFromAnswer(value: string): Horizon {
  switch (value) {
    case '1mo': return 'daily';
    case '3mo': return 'short';
    case '1y': return 'medium';
    case '3y': return 'long';
    default: return 'medium';
  }
}

function targetDateFor(horizon: Horizon): string {
  switch (horizon) {
    case 'daily': return dayKey(addDays(new Date(), 30));
    case 'short': return dayKey(addDays(new Date(), 90));
    case 'medium': return dayKey(addDays(new Date(), 365));
    default: return dayKey(addDays(new Date(), 365 * 3));
  }
}

function guessArea(text: string, answers: AnswersMap): string {
  const lower = text.toLowerCase();
  if (/(money|income|earn|salary|invest|business|client|freelance)/.test(lower)) return 'finance';
  if (/(learn|study|course|exam|degree|skill)/.test(lower)) return 'learning';
  if (/(health|fitness|gym|run|sleep|weight)/.test(lower)) return 'health';
  if (/(job|career|work|position|company|hire)/.test(lower)) return 'career';
  if (/(build|ship|product|app|project)/.test(lower)) return 'building';
  const interests = splitList(answers.interests);
  return interests[0] ?? 'general';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export type { GapType };
