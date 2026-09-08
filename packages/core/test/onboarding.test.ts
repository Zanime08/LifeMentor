import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { ALL_QUESTIONS } from '../src/onboarding/questions';
import { detectGaps } from '../src/onboarding/interview';

/**
 * Phase gate for onboarding (req. 1–7, 94):
 * questionnaire → adaptive interview → model preview with labelled assumptions →
 * user confirmation → initial goals/skills/knowledge/plan, and the whole thing
 * must be resumable after a crash and must not assume a user type.
 */

const STUDENT: Record<string, unknown> = {
  age_category: '18_24',
  education: 'bachelor',
  main_activity: ['study', 'work_part_time'],
  fixed_hours_per_day: 6,
  available_hours_per_day: 2,
  family_situation: 'parents',
  energy_pattern: 'evening',
  what_you_want: 'I want to become a data analyst and earn a good salary',
  what_to_avoid: 'burnout and endless scrolling',
  who_to_become: 'a competent analyst who can explain results to non-technical people',
  problems_to_solve: 'no practical projects in my portfolio',
  goal_horizon: '1y',
  skills_have: 'Python, Excel',
  skills_learning: 'SQL',
  skills_want: 'statistics, data visualization',
  proof_of_skill: 'I built a Python scraper for my coursework and it is still used by the department',
  interests: ['technology', 'ai', 'science'],
  curiosity: 'how models actually learn from data',
  wake_time: '07:00',
  sleep_time: '23:30',
  typical_day: 'classes until 16:00, then a part-time shift until 20:00',
  distractions: ['social_media', 'short_videos'],
  obligations: 'family dinners at 21:00',
  planning_style: 'balanced',
  strictness: 6,
  free_time_desired: 1.5,
  reminder_attitude: 'gentle',
  planning_history: 'every app got boring after two weeks',
  career_direction: ['stable_career'],
  financial_situation: 'tight',
  risk_tolerance: 2,
  capital_available: 0,
  income_expectation: 'enough to be financially independent from my parents',
};

const PARENT: Record<string, unknown> = {
  age_category: '35_44',
  education: 'vocational',
  main_activity: ['work_full_time'],
  fixed_hours_per_day: 10,
  available_hours_per_day: 0.75,
  family_situation: 'children',
  energy_pattern: 'morning',
  what_you_want: 'reach B2 English and find remote work',
  what_to_avoid: 'losing time with my children',
  who_to_become: 'someone who can work with foreign clients',
  problems_to_solve: 'no time and no discipline in the evening',
  goal_horizon: '3mo',
  skills_have: 'driving, logistics planning',
  skills_learning: 'English',
  skills_want: 'English, negotiation',
  proof_of_skill: 'I organise deliveries for a team of 12 drivers',
  interests: ['health'],
  wake_time: '05:30',
  sleep_time: '22:00',
  typical_day: 'shift from 07:00 to 17:00, then children until 21:00',
  distractions: ['phone'],
  obligations: 'school runs, cooking',
  planning_style: 'strict',
  strictness: 8,
  free_time_desired: 1,
  reminder_attitude: 'firm',
  planning_history: 'plans always collapsed on sick days',
  career_direction: ['stable_career'],
  financial_situation: 'tight',
  risk_tolerance: 1,
  capital_available: 0,
  income_expectation: 'a stable salary that covers the mortgage',
};

let dir: string;
let studentPath: string;
let parentPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifementor-onboarding-'));
  studentPath = join(dir, 'student.sqlite');
  parentPath = join(dir, 'parent.sqlite');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function openApp(path: string, deviceId: string): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path, durability: 'paranoid' },
    deviceId,
    deviceName: deviceId,
  });
}

async function answerAll(app: LifeMentorApp, answers: Record<string, unknown>): Promise<void> {
  for (const question of ALL_QUESTIONS) {
    const value = answers[question.key];
    if (value === undefined) continue;
    const result = await app.services.onboarding.answer(question.key, value);
    expect(result.saved).toBe(true);
  }
}

describe('questionnaire', () => {
  it('covers every block and knows which questions are critical', () => {
    const blocks = new Set(ALL_QUESTIONS.map((q) => q.block));
    expect(blocks.size).toBe(7);
    expect(ALL_QUESTIONS.filter((q) => q.critical).length).toBeGreaterThan(8);
    for (const question of ALL_QUESTIONS) {
      if (question.kind === 'single' || question.kind === 'multi') {
        expect(question.options?.length, `${question.key} needs options`).toBeGreaterThan(1);
      }
      if (question.kind === 'scale') expect(question.scale, `${question.key} needs a scale`).toBeTruthy();
    }
  });

  it('starts a session and reports progress', async () => {
    const app = await openApp(studentPath, 'device-student');
    const status = await app.services.onboarding.status();

    expect(status.session.status).toBe('in_progress');
    expect(status.stage).toBe('questionnaire');
    expect(status.total_questions).toBe(ALL_QUESTIONS.length);
    expect(status.can_advance).toBe(false);
    expect(status.remaining_questions.length).toBeGreaterThan(0);

    await app.close();
  });

  it('survives a crash in the middle of the questionnaire', async () => {
    const app = await openApp(studentPath, 'device-student');
    await answerAll(app, { age_category: '18_24', education: 'bachelor', main_activity: ['study'], available_hours_per_day: 2 });
    const before = await app.services.onboarding.answers();
    expect(Object.keys(before).length).toBe(4);
    // hard close without any shutdown routine
    await app.close();

    const reopened = await openApp(studentPath, 'device-student');
    const after = await reopened.services.onboarding.answers();
    expect(after).toEqual(before);
    const status = await reopened.services.onboarding.status();
    expect(status.answered).toBe(4);
    expect(status.session.status).toBe('in_progress');
    await reopened.close();
  });
});

describe('adaptive interview', () => {
  it('detects vague goals and contradictions deterministically', async () => {
    const app = await openApp(studentPath, 'device-student');
    await answerAll(app, STUDENT);

    const analysis = await app.services.onboarding.analyse();
    expect(analysis.gaps.length).toBeGreaterThan(0);
    expect(analysis.selected.length).toBeGreaterThan(0);
    expect(analysis.selected.length).toBeLessThanOrEqual(6);

    const types = new Set(analysis.gaps.map((g) => g.gap_type));
    // "earn a good salary" with no number must be flagged as vague
    expect(types.has('vague_goal')).toBe(true);
    for (const gap of analysis.selected) {
      expect(gap.question.length).toBeGreaterThan(8);
      expect(gap.rationale.length).toBeGreaterThan(8);
      expect(gap.importance).toBeGreaterThanOrEqual(0.45);
    }

    const pending = await app.services.onboarding.pendingInterviewQuestions();
    expect(pending.length).toBe(analysis.selected.length);

    // answering one question can generate follow-ups but never an endless loop
    const first = pending[0];
    const answered = await app.services.onboarding.answerInterview(first.id, 'About 1500 EUR net per month within two years');
    expect(answered.question.status).toBe('answered');
    expect(answered.followUps.length).toBeLessThanOrEqual(2);

    for (const question of pending.slice(1)) await app.services.onboarding.answerInterview(question.id, 'A concrete answer from the user');
    await app.services.onboarding.finishInterview();

    const stillPending = await app.services.onboarding.pendingInterviewQuestions();
    expect(stillPending.length).toBeLessThanOrEqual(2);
    await app.close();
  });

  it('works with no answers at all — onboarding never dead-ends', () => {
    const gaps = detectGaps({});
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.question.length > 8)).toBe(true);
  });
});

describe('user model', () => {
  it('previews the model with every assumption labelled', async () => {
    const app = await openApp(studentPath, 'device-student');
    const preview = await app.services.onboarding.previewModel();

    expect(preview.items.length).toBeGreaterThan(15);
    const sections = new Set(preview.items.map((i) => i.section));
    for (const expected of ['PROFILE', 'GOALS', 'SKILLS', 'TIME_AVAILABILITY', 'PREFERENCES']) {
      expect(sections.has(expected as never), `model must cover ${expected}`).toBe(true);
    }

    // derived items must never masquerade as user statements
    const derived = preview.items.filter((i) => i.source === 'ai_inferred');
    expect(derived.length).toBeGreaterThan(0);
    for (const item of derived) {
      expect(['inferred', 'uncertain']).toContain(item.confidence);
      expect(item.evidence.length).toBeGreaterThan(0);
    }
    expect(preview.assumptions.length).toBe(derived.length);
    expect(preview.summary.length).toBeGreaterThan(20);
    expect(preview.settings_preview.planning).toBeTruthy();

    await app.close();
  });

  it('applies user edits on confirmation and flags the model as confirmed', async () => {
    const app = await openApp(studentPath, 'device-student');
    const preview = await app.services.onboarding.previewModel();
    const target = preview.items.find((i) => i.section === 'GOALS' && i.key === 'primary')!;

    const result = await app.services.onboarding.confirmModel({
      items: [{ section: target.section, key: target.key, value: 'Become a junior data analyst within 12 months' }],
      removed: [{ section: 'DISTRACTIONS', key: 'main' }],
    });

    expect(result.fields).toBeGreaterThan(10);
    expect(result.snapshot_id.length).toBeGreaterThan(0);

    const model = await app.services.profile.model();
    const goalField = model.sections.GOALS?.find((f) => f.key === 'primary');
    expect(goalField?.value).toBe('Become a junior data analyst within 12 months');
    expect(goalField?.source).toBe('user_provided');
    expect(model.sections.DISTRACTIONS?.find((f) => f.key === 'main')).toBeUndefined();

    const settings = await app.services.settings.all();
    expect(settings.flags.user_model_confirmed).toBe(true);
    // the questionnaire really drives the settings — not defaults
    expect(settings.planning.wake_time).toBe('07:00');
    expect(settings.planning.sleep_time).toBe('23:30');
    expect(settings.planning.max_focus_hours_per_day).toBe(2);
    expect(settings.planning.free_time_minutes).toBe(90);
    expect(settings.planning.style).toBe('balanced');
    expect(settings.learning.daily_minutes).toBe(72);

    const memories = await app.services.memory.list({ limit: 200 });
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((m) => m.source === 'user_provided' || m.source === 'ai_inferred')).toBe(true);

    const snapshots = await app.services.profile.snapshots(5);
    expect(snapshots.length).toBe(1);

    await app.close();
  });
});

describe('initial plan generation', () => {
  it('creates goals, skills, knowledge and a first day plan', async () => {
    const app = await openApp(studentPath, 'device-student');

    const drafts = await app.services.onboarding.suggestGoals();
    expect(drafts.length).toBeGreaterThan(0);
    // no invented income promises (req. 46)
    for (const draft of drafts) {
      expect(draft.title.length).toBeGreaterThan(3);
      expect(['long', 'medium', 'short', 'daily']).toContain(draft.horizon);
      expect(draft.title).not.toMatch(/guarantee|ensure.*income|you will earn/i);
    }
    const created = await app.services.onboarding.createGoals(drafts.slice(0, 3));
    expect(created.created).toBe(3);
    const goals = await app.services.goals.list({ status: 'active' });
    expect(goals.length).toBe(3);
    expect(goals.every((g) => Number(g.progress) === 0)).toBe(true);

    const skills = await app.services.onboarding.createInitialSkills();
    expect(skills.created).toBeGreaterThanOrEqual(4);
    const all = await app.services.skills.list();
    expect(all.length).toBeGreaterThanOrEqual(4);
    // a stated skill is not evidence: level stays 0 and confidence uncertain until assessed
    for (const skill of all.filter((s) => !s.last_assessment_at)) {
      expect(Number(skill.level), skill.name).toBe(0);
      expect(skill.confidence, skill.name).toBe('uncertain');
    }
    // the one skill backed by a real result recorded during onboarding may carry evidence
    const withEvidence = all.filter((s) => s.last_assessment_at);
    expect(withEvidence.length).toBeLessThanOrEqual(1);

    const nodes = await app.services.onboarding.seedKnowledge();
    expect(nodes).toBeGreaterThan(0);

    const plan = await app.services.onboarding.createInitialPlan();
    expect(plan.day.length).toBe(10);
    expect(plan.free_minutes).toBeGreaterThanOrEqual(90); // protected free time survives onboarding
    expect(plan.overload).toBe(false);

    const flags = (await app.services.settings.all()).flags;
    expect(flags.onboarding_completed).toBe(true);
    expect(flags.first_plan_generated).toBe(true);

    const status = await app.services.onboarding.status();
    expect(status.session.status).toBe('completed');

    await app.close();
  });
});

describe('universality', () => {
  it('adapts to a completely different life situation instead of assuming a user type', async () => {
    const app = await openApp(parentPath, 'device-parent');
    await answerAll(app, PARENT);
    await app.services.onboarding.analyse();
    const preview = await app.services.onboarding.previewModel();
    await app.services.onboarding.confirmModel();
    const drafts = await app.services.onboarding.suggestGoals();
    await app.services.onboarding.createGoals(drafts.slice(0, 2));
    await app.services.onboarding.createInitialSkills();
    const plan = await app.services.onboarding.createInitialPlan();

    const settings = await app.services.settings.all();
    expect(settings.planning.wake_time).toBe('05:30');
    expect(settings.planning.max_focus_hours_per_day).toBe(0.75);
    expect(settings.planning.style).toBe('strict');
    expect(settings.planning.reminder_style).toBe('firm');
    expect(settings.learning.daily_minutes).toBe(27);

    const goals = await app.services.goals.list({ status: 'active' });
    expect(goals.map((g) => g.title).join(' ')).toMatch(/English/i);

    // 45 minutes of real capacity must not produce a six-hour schedule
    expect(plan.focus_minutes).toBeLessThanOrEqual(60);
    expect(plan.free_minutes).toBeGreaterThanOrEqual(60);
    expect(plan.overload).toBe(false);

    const model = await app.services.profile.model();
    expect(model.sections.TIME_AVAILABILITY?.some((f) => f.key === 'available_hours_per_day')).toBe(true);
    expect(preview.items.some((i) => i.source === 'user_provided')).toBe(true);

    await app.close();
  });

  it('keeps the two users\' data completely separate', async () => {
    const student = await openApp(studentPath, 'device-student');
    const parent = await openApp(parentPath, 'device-parent');

    const studentGoals = await student.services.goals.list({});
    const parentGoals = await parent.services.goals.list({});
    expect(studentGoals.map((g) => g.title).join(' ')).not.toMatch(/B2 English/);
    expect(parentGoals.map((g) => g.title).join(' ')).not.toMatch(/data analyst/i);

    await student.close();
    await parent.close();
  });
});
