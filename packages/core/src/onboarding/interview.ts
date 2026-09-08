import type { GapType } from '../domain/types';
import { findQuestion } from './questions';

export type AnswersMap = Record<string, unknown>;

export interface GapCandidate {
  gap_type: GapType;
  /** Which part of the user model this question improves. */
  target: string;
  question: string;
  /** Shown to the user: why the mentor is asking. */
  rationale: string;
  /** 0..1 — how much the answer would improve the model. */
  importance: number;
  /** Optional answer choices; free text when absent. */
  options?: { id: string; label: string }[];
  related_question_key?: string;
}

/** Optional AI-assisted gap detection (implemented by the AI layer). */
export interface InterviewAI {
  proposeQuestions(model: { answers: AnswersMap; gaps: GapCandidate[] }): Promise<GapCandidate[]>;
}

const VAGUE_MONEY = /(earn|earning|money|rich|wealth|income|well-?paid|financial(?:ly)? (?:free|independen)|good salary|more cash|успеш|хорошо зарабатывать|зарабатывать)/i;
const VAGUE_SUCCESS = /(success|successful|better life|improve my life|be happy|find myself|something meaningful)/i;

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

function isAnswered(answers: AnswersMap, key: string): boolean {
  const value = answers[key];
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0 && !value.every((v) => v === 'prefer_not_to_say');
  return String(value).trim() !== '' && String(value) !== 'prefer_not_to_say';
}

/**
 * Stage 2 gap detection (req. 3).
 *
 * Deterministic, explainable detectors find: missing data, contradictions, vague goals,
 * conflicting goals, skill ambiguity, unknown constraints and missing horizons.
 * Each candidate carries a rationale so the user can see *why* they are being asked.
 */
export function detectGaps(answers: AnswersMap): GapCandidate[] {
  const gaps: GapCandidate[] = [];

  const fixed = num(answers.fixed_hours_per_day);
  const available = num(answers.available_hours_per_day);
  const freeDesired = num(answers.free_time_desired);
  const wake = text(answers.wake_time);
  const sleep = text(answers.sleep_time);
  const wants = text(answers.what_you_want);
  const incomeExpectation = text(answers.income_expectation);
  const career = list(answers.career_direction);
  const skillsHave = list(answers.skills_have);
  const skillsWant = list(answers.skills_want);
  const proof = text(answers.proof_of_skill);
  const obligations = text(answers.obligations);
  const interests = list(answers.interests);
  const horizon = text(answers.goal_horizon);
  const style = text(answers.planning_style);
  const reminders = text(answers.reminder_attitude);
  const activities = list(answers.main_activity);

  // ── missing data ────────────────────────────────────────────────────────────
  if (available === null) {
    gaps.push({
      gap_type: 'missing_data', target: 'TIME_AVAILABILITY.available_hours_per_day', importance: 0.95,
      question: 'How many hours a day can you realistically spend on your own development?',
      rationale: 'Without this I cannot build a plan that survives contact with your day.',
      related_question_key: 'available_hours_per_day',
    });
  }
  if (fixed === null) {
    gaps.push({
      gap_type: 'missing_data', target: 'CONSTRAINTS.fixed_hours_per_day', importance: 0.85,
      question: 'How many hours a day are already fixed (work, classes, commute, care)?',
      rationale: 'Fixed hours decide how much room is left. Guessing here produces impossible plans.',
      related_question_key: 'fixed_hours_per_day',
    });
  }
  if (!wants) {
    gaps.push({
      gap_type: 'missing_data', target: 'GOALS.primary', importance: 0.98,
      question: 'If a year from now things had clearly got better, what would have changed?',
      rationale: 'I have no direction from you yet, and everything else depends on it.',
      related_question_key: 'what_you_want',
    });
  }
  if (!career.length || career.includes('undecided')) {
    gaps.push({
      gap_type: 'missing_data', target: 'CAREER_DIRECTION.primary', importance: 0.7,
      question: 'Money and work: what are you optimising for right now — stability, income level, independence, or building something of your own?',
      rationale: 'You did not pick a career/finance direction, or picked "not decided". These lead to very different plans.',
      options: [
        { id: 'stability', label: 'Stability first' }, { id: 'income', label: 'Higher income' },
        { id: 'independence', label: 'Independence from one employer' }, { id: 'build', label: 'Build my own thing' },
        { id: 'undecided', label: 'Genuinely not decided yet' },
      ],
      related_question_key: 'career_direction',
    });
  }
  if (!interests.length) {
    gaps.push({
      gap_type: 'missing_data', target: 'INTERESTS.areas', importance: 0.6,
      question: 'What topics do you actually enjoy, even a little?',
      rationale: 'Interests drive learning suggestions and news ranking; without them everything is generic.',
      related_question_key: 'interests',
    });
  }

  // ── contradictions ─────────────────────────────────────────────────────────
  if (fixed !== null && available !== null) {
    const wakingHours = wake && sleep ? wakingHoursBetween(wake, sleep) : 16;
    const needed = fixed + available + (freeDesired ?? 1.5) + 2.5; // +2.5h for meals/hygiene/chores
    if (needed > wakingHours) {
      gaps.push({
        gap_type: 'contradiction', target: 'TIME_AVAILABILITY.realistic_load', importance: 0.95,
        question: `Your day has ${fixed}h fixed, and you want ${available}h of development plus ${freeDesired ?? 1.5}h free — that is ${round1(needed)}h inside a ${wakingHours}h day. What gives: fewer development hours, or something else has to move?`,
        rationale: 'These numbers cannot all be true at once. I would rather shrink the plan now than have you fail it later.',
        options: [
          { id: 'reduce_dev', label: `Cut development time to ~${Math.max(0.5, round1(wakingHours - fixed - (freeDesired ?? 1.5) - 2.5))}h` },
          { id: 'reduce_free', label: 'Protect less free time' },
          { id: 'move_fixed', label: 'Something fixed can actually move' },
          { id: 'weekends', label: 'Weekdays are full — use weekends' },
        ],
      });
    }
    if (available > 8) {
      gaps.push({
        gap_type: 'contradiction', target: 'TIME_AVAILABILITY.realistic_load', importance: 0.7,
        question: `${available}h a day of self-development is more than most people sustain. Shall we start with 2–3h and grow it if you keep it up for two weeks?`,
        rationale: 'Plans that start too heavy usually collapse in week two. I would rather prove capacity first.',
        options: [{ id: 'start_small', label: 'Start with 2–3h' }, { id: 'keep', label: `No, keep ${available}h` }],
      });
    }
  }
  if (style === 'strict' && reminders === 'none') {
    gaps.push({
      gap_type: 'contradiction', target: 'PREFERENCES.planning', importance: 0.6,
      question: 'You asked for a strict plan but minimal reminders. Should I hold you to the plan without pushing notifications, or remind you firmly?',
      rationale: 'Strictness without reminders usually means the plan is quietly abandoned.',
      options: [{ id: 'strict_quiet', label: 'Strict plan, quiet reminders' }, { id: 'strict_firm', label: 'Strict plan, firm reminders' }, { id: 'soft', label: 'Softer plan' }],
    });
  }

  // ── vague goals ────────────────────────────────────────────────────────────
  const moneyIsVague = VAGUE_MONEY.test(wants) && (!incomeExpectation || incomeExpectation.length < 12 || VAGUE_MONEY.test(incomeExpectation));
  if (moneyIsVague) {
    gaps.push({
      gap_type: 'vague_goal', target: 'FINANCIAL_DIRECTION.definition', importance: 0.92,
      question: 'What does "earning well" mean for you: a specific monthly amount, stability, freedom from one employer, or enough to stop worrying?',
      rationale: 'You said you want to earn well, but "well" means very different plans depending on the answer.',
      options: [
        { id: 'amount', label: 'A specific amount (tell me the number)' },
        { id: 'stability', label: 'Stable, predictable income' },
        { id: 'freedom', label: 'Not depending on one employer' },
        { id: 'no_worry', label: 'Enough to stop worrying about money' },
      ],
      related_question_key: 'income_expectation',
    });
  }
  if (VAGUE_SUCCESS.test(wants) && wants.length < 90) {
    gaps.push({
      gap_type: 'vague_goal', target: 'GOALS.definition', importance: 0.8,
      question: 'What would "success" look like concretely in 12 months — one thing you could point at and say "this happened"?',
      rationale: 'The goal is currently too general to plan against or to measure.',
      related_question_key: 'what_you_want',
    });
  }
  if (!horizon || horizon === 'unclear') {
    gaps.push({
      gap_type: 'missing_horizon', target: 'GOALS.horizon', importance: 0.75,
      question: 'When do you want to see the first real result: a month, three months, or a year?',
      rationale: 'Without a horizon I cannot decide between quick wins and long investments.',
      options: [{ id: '1mo', label: 'A month' }, { id: '3mo', label: 'Three months' }, { id: '1y', label: 'A year' }, { id: 'unsure', label: 'Still unsure' }],
      related_question_key: 'goal_horizon',
    });
  }

  // ── goal conflicts ─────────────────────────────────────────────────────────
  const wantsStability = career.includes('stable_career');
  const wantsBusiness = career.includes('own_business') || career.includes('financial_independence') || career.includes('multiple_incomes');
  if (wantsStability && wantsBusiness) {
    gaps.push({
      gap_type: 'goal_conflict', target: 'CAREER_DIRECTION.priority', importance: 0.85,
      question: 'You want both a stable career and your own business/independence. In the next 12 months, which one gets the primary hours — and can the other run small on the side?',
      rationale: 'Both are legitimate, but they compete for the same evenings. Sequencing beats splitting.',
      options: [
        { id: 'stability_first', label: 'Stable career first, business small' },
        { id: 'business_first', label: 'Business first, career as income floor' },
        { id: 'parallel', label: 'Truly parallel (accept slower progress)' },
      ],
    });
  }
  if ((career.includes('investments') || career.includes('financial_independence')) && num(answers.capital_available) === 0 && text(answers.financial_situation) === 'tight') {
    gaps.push({
      gap_type: 'goal_conflict', target: 'FINANCIAL_DIRECTION.sequence', importance: 0.7,
      question: 'Investing with no spare capital usually means the first step is income or a buffer, not markets. Should we sequence it that way?',
      rationale: 'Your finance goal needs a precondition you do not have yet.',
      options: [{ id: 'buffer_first', label: 'Build income/buffer first' }, { id: 'learn_only', label: 'Learn investing now, fund later' }, { id: 'disagree', label: 'I have capital I did not mention' }],
    });
  }
  if (skillsWant.length >= 4) {
    gaps.push({
      gap_type: 'goal_conflict', target: 'SKILLS.priority', importance: 0.72,
      question: `You want to learn ${skillsWant.length} things (${skillsWant.slice(0, 5).join(', ')}). Which ONE matters most in the next 3 months?`,
      rationale: 'Parallel learning of many skills is the most common way nothing gets finished.',
      options: skillsWant.slice(0, 6).map((s) => ({ id: s.toLowerCase().replace(/\s+/g, '_'), label: s })),
    });
  }

  // ── skill ambiguity ────────────────────────────────────────────────────────
  if (skillsHave.length && !proof) {
    gaps.push({
      gap_type: 'skill_ambiguity', target: 'SKILLS.evidence', importance: 0.78,
      question: `You listed ${skillsHave.slice(0, 4).join(', ')}. For the most important one: what have you actually built, shipped or passed with it?`,
      rationale: 'Real evidence sets your starting level far better than a self-rating, and it decides where the learning path starts.',
      related_question_key: 'proof_of_skill',
    });
  }
  if (skillsWant.length && activities.length === 0) {
    gaps.push({
      gap_type: 'unknown_constraint', target: 'CONSTRAINTS.structure', importance: 0.5,
      question: 'Nothing structured fills your days right now. Is that by choice, or is it something you want to change first?',
      rationale: 'An unstructured day and an overloaded day need opposite plans.',
    });
  }

  // ── unknown constraints ────────────────────────────────────────────────────
  if (!obligations && fixed !== null && fixed >= 6) {
    gaps.push({
      gap_type: 'unknown_constraint', target: 'CONSTRAINTS.disruptions', importance: 0.68,
      question: `With ${fixed}h of fixed commitments, what usually breaks your plans — shifts, health, family, exams, energy?`,
      rationale: 'Knowing the usual disruption lets me build slack where it is actually needed.',
      related_question_key: 'obligations',
    });
  }
  if (!isAnswered(answers, 'planning_history') && text(answers.distractions ?? '').length === 0 && list(answers.distractions).length === 0) {
    gaps.push({
      gap_type: 'unknown_constraint', target: 'DISTRACTIONS.main', importance: 0.55,
      question: 'What has derailed your previous attempts — or is this the first real attempt?',
      rationale: 'Past failure modes are the most useful constraint data there is.',
      related_question_key: 'planning_history',
    });
  }
  if (wake && sleep && wakingHoursBetween(wake, sleep) < 12) {
    gaps.push({
      gap_type: 'contradiction', target: 'TIME_AVAILABILITY.sleep', importance: 0.5,
      question: `You sleep from ${sleep} to ${wake} — that looks short. Is that normal, or is the schedule currently unusual?`,
      rationale: 'I will not touch your sleep, but I need to know whether it is the real baseline.',
      options: [{ id: 'normal', label: 'That is normal for me' }, { id: 'unusual', label: 'Unusual period' }, { id: 'want_change', label: 'I would like to fix it' }],
    });
  }

  return gaps.sort((a, b) => b.importance - a.importance);
}

/**
 * Pick the questions that actually improve the model (req. 3: never 100 questions).
 * Deduplicates by target, drops already-asked ones, and stops when marginal value is low.
 */
export function selectQuestions(
  candidates: GapCandidate[],
  options: { max?: number; minImportance?: number; askedTargets?: string[]; answeredTargets?: string[] } = {},
): GapCandidate[] {
  const max = options.max ?? 6;
  const minImportance = options.minImportance ?? 0.45;
  const asked = new Set(options.askedTargets ?? []);
  const answered = new Set(options.answeredTargets ?? []);
  const seenTargets = new Set<string>();
  const out: GapCandidate[] = [];

  for (const candidate of [...candidates].sort((a, b) => b.importance - a.importance)) {
    if (out.length >= max) break;
    if (candidate.importance < minImportance) continue;
    if (asked.has(candidate.target) || answered.has(candidate.target)) continue;
    if (seenTargets.has(candidate.target)) continue;
    if (candidate.related_question_key && answered.has(`question:${candidate.related_question_key}`)) continue;
    seenTargets.add(candidate.target);
    out.push(candidate);
  }
  return out;
}

/** Merge AI-proposed questions with the deterministic ones, deduplicating by target. */
export function mergeCandidates(deterministic: GapCandidate[], aiProposed: GapCandidate[], max = 8): GapCandidate[] {
  const seen = new Set<string>();
  const merged: GapCandidate[] = [];
  for (const candidate of [...deterministic, ...aiProposed].sort((a, b) => b.importance - a.importance)) {
    const key = candidate.target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...candidate, gap_type: isValidGapType(candidate.gap_type) ? candidate.gap_type : 'missing_data' });
    if (merged.length >= max) break;
  }
  return merged;
}

function isValidGapType(value: string): value is GapType {
  return ['missing_data', 'contradiction', 'vague_goal', 'goal_conflict', 'skill_ambiguity', 'unknown_constraint', 'missing_horizon'].includes(value);
}

export function wakingHoursBetween(wake: string, sleep: string): number {
  const [wh, wm] = wake.split(':').map(Number);
  const [sh, sm] = sleep.split(':').map(Number);
  const wakeMinutes = (wh ?? 7) * 60 + (wm ?? 0);
  const sleepMinutes = (sh ?? 23) * 60 + (sm ?? 0);
  const diff = sleepMinutes > wakeMinutes ? sleepMinutes - wakeMinutes : 24 * 60 - wakeMinutes + sleepMinutes;
  return Math.round((diff / 60) * 10) / 10;
}

function round1(value: number): number { return Math.round(value * 10) / 10; }

/** Convenience: is this question key present in the questionnaire (used when persisting answers)? */
export function isKnownQuestion(key: string): boolean { return Boolean(findQuestion(key)); }
