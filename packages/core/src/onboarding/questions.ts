/**
 * Stage 1: the universal basic questionnaire (req. 2).
 *
 * It deliberately assumes NOTHING about who the user is — no profession, no age, no goal set.
 * Every personal question has an opt-out, and every answer is stored with source `user_provided`.
 */

export type QuestionKind = 'single' | 'multi' | 'text' | 'scale' | 'time' | 'number';

export interface QuestionOption { id: string; label: string; hint?: string }

export interface Question {
  key: string;
  block: QuestionBlock['id'];
  kind: QuestionKind;
  prompt: string;
  help?: string;
  options?: QuestionOption[];
  scale?: { min: number; max: number; minLabel: string; maxLabel: string };
  placeholder?: string;
  optional?: boolean;
  unit?: string;
  /** Used by the gap detectors to decide whether an answer is informative. */
  critical?: boolean;
}

export interface QuestionBlock {
  id: 'situation' | 'goals' | 'skills' | 'interests' | 'lifestyle' | 'planning' | 'career_finance';
  title: string;
  subtitle: string;
  questions: Question[];
}

const PREFER_NOT_TO_SAY: QuestionOption = { id: 'prefer_not_to_say', label: 'Prefer not to say' };

export const QUESTIONNAIRE: QuestionBlock[] = [
  {
    id: 'situation',
    title: 'Your situation',
    subtitle: 'So the plan fits your real life, not an imaginary one.',
    questions: [
      {
        key: 'age_category', block: 'situation', kind: 'single', prompt: 'Which age range fits you?', optional: true,
        options: [
          { id: 'under_18', label: 'Under 18' }, { id: '18_24', label: '18–24' }, { id: '25_34', label: '25–34' },
          { id: '35_44', label: '35–44' }, { id: '45_54', label: '45–54' }, { id: '55_plus', label: '55+' }, PREFER_NOT_TO_SAY,
        ],
      },
      {
        key: 'education', block: 'situation', kind: 'single', prompt: 'What is your education level?', optional: true,
        options: [
          { id: 'school', label: 'School' }, { id: 'secondary', label: 'Secondary' }, { id: 'vocational', label: 'Vocational / college' },
          { id: 'bachelor', label: "Bachelor's" }, { id: 'master', label: "Master's" }, { id: 'phd', label: 'PhD' },
          { id: 'self_taught', label: 'Mostly self-taught' }, { id: 'other', label: 'Other' }, PREFER_NOT_TO_SAY,
        ],
      },
      {
        key: 'main_activity', block: 'situation', kind: 'multi', prompt: 'What fills your time right now?', critical: true,
        options: [
          { id: 'study', label: 'Studying' }, { id: 'work_full_time', label: 'Working full-time' }, { id: 'work_part_time', label: 'Working part-time' },
          { id: 'freelance', label: 'Freelancing' }, { id: 'business', label: 'Running a business' }, { id: 'job_search', label: 'Looking for work' },
          { id: 'caregiving', label: 'Caring for family' }, { id: 'military', label: 'Military service' }, { id: 'none', label: 'Nothing structured right now' },
          { id: 'other', label: 'Other' },
        ],
      },
      {
        key: 'fixed_hours_per_day', block: 'situation', kind: 'number', prompt: 'How many hours a day are already taken by fixed obligations?',
        help: 'Classes, work, commute, care duties — everything you cannot move.', unit: 'hours', critical: true, placeholder: 'e.g. 8',
      },
      {
        key: 'available_hours_per_day', block: 'situation', kind: 'number', prompt: 'Realistically, how many hours a day could you spend on your own development?',
        help: 'Be honest — an optimistic number produces a plan you will abandon.', unit: 'hours', critical: true, placeholder: 'e.g. 2',
      },
      {
        key: 'family_situation', block: 'situation', kind: 'single', prompt: 'Who do you live with? (only if you want to share)', optional: true,
        options: [
          { id: 'alone', label: 'Alone' }, { id: 'partner', label: 'With a partner' }, { id: 'children', label: 'With children' },
          { id: 'parents', label: 'With parents / family' }, { id: 'shared', label: 'Shared flat' }, PREFER_NOT_TO_SAY,
        ],
      },
      {
        key: 'energy_pattern', block: 'situation', kind: 'single', prompt: 'When is your mind sharpest?',
        options: [
          { id: 'morning', label: 'Morning' }, { id: 'afternoon', label: 'Afternoon' }, { id: 'evening', label: 'Evening' },
          { id: 'night', label: 'Late night' }, { id: 'variable', label: 'It changes' },
        ],
      },
    ],
  },
  {
    id: 'goals',
    title: 'What you want',
    subtitle: 'In your own words. Vague is fine — I will ask follow-ups.',
    questions: [
      { key: 'what_you_want', block: 'goals', kind: 'text', prompt: 'What do you want to achieve?', help: 'Anything: money, a profession, a skill, health, freedom, a project.', critical: true, placeholder: 'e.g. I want to earn well and not depend on one employer' },
      { key: 'what_to_avoid', block: 'goals', kind: 'text', prompt: 'What do you want to avoid or get out of?', optional: true, placeholder: 'e.g. burnout, dead-end job, debt' },
      { key: 'who_to_become', block: 'goals', kind: 'text', prompt: 'Who do you want to become?', optional: true, placeholder: 'e.g. a backend engineer who can build products alone' },
      { key: 'problems_to_solve', block: 'goals', kind: 'text', prompt: 'Which concrete problems should we solve first?', optional: true, placeholder: 'e.g. no routine, too many distractions, no direction' },
      {
        key: 'goal_horizon', block: 'goals', kind: 'single', prompt: 'When do you want to see the first real result?', critical: true,
        options: [
          { id: '1mo', label: 'Within a month' }, { id: '3mo', label: 'Within 3 months' }, { id: '1y', label: 'Within a year' },
          { id: '3y', label: '2–5 years' }, { id: 'unclear', label: 'Not sure yet' },
        ],
      },
    ],
  },
  {
    id: 'skills',
    title: 'What you can do',
    subtitle: 'This becomes your starting skill map — you can correct every level later.',
    questions: [
      { key: 'skills_have', block: 'skills', kind: 'text', prompt: 'What can you already do?', help: 'Comma-separated. Include things you are "only okay" at.', critical: true, placeholder: 'e.g. English B2, basic Python, driving, cooking' },
      { key: 'skills_learning', block: 'skills', kind: 'text', prompt: 'What are you learning right now?', optional: true, placeholder: 'e.g. Python, guitar' },
      { key: 'skills_want', block: 'skills', kind: 'text', prompt: 'What do you want to master?', critical: true, placeholder: 'e.g. backend development, investing, public speaking' },
      {
        key: 'proof_of_skill', block: 'skills', kind: 'text', prompt: 'Anything you have actually built, shipped or passed?',
        help: 'Real evidence sets your level much better than a self-rating.', optional: true, placeholder: 'e.g. a Telegram bot, a course certificate, 2 years of sales work',
      },
    ],
  },
  {
    id: 'interests',
    title: 'What pulls you',
    subtitle: 'Used to rank news, suggest learning and connect ideas.',
    questions: [
      {
        key: 'interests', block: 'interests', kind: 'multi', prompt: 'Which areas interest you?', critical: true,
        options: [
          { id: 'technology', label: 'Technology' }, { id: 'programming', label: 'Programming' }, { id: 'ai', label: 'AI' },
          { id: 'science', label: 'Science' }, { id: 'business', label: 'Business' }, { id: 'finance', label: 'Finance & investing' },
          { id: 'sport', label: 'Sport & fitness' }, { id: 'creativity', label: 'Creativity & art' }, { id: 'music', label: 'Music' },
          { id: 'languages', label: 'Languages' }, { id: 'history', label: 'History' }, { id: 'philosophy', label: 'Philosophy' },
          { id: 'health', label: 'Health' }, { id: 'games', label: 'Games' }, { id: 'travel', label: 'Travel' }, { id: 'other', label: 'Other' },
        ],
      },
      { key: 'interests_other', block: 'interests', kind: 'text', prompt: 'Anything else worth knowing?', optional: true },
      { key: 'curiosity', block: 'interests', kind: 'text', prompt: 'What could you read or talk about for hours?', optional: true },
    ],
  },
  {
    id: 'lifestyle',
    title: 'Your day',
    subtitle: 'The planner is built around this, not against it.',
    questions: [
      { key: 'wake_time', block: 'lifestyle', kind: 'time', prompt: 'When do you usually get up?', critical: true },
      { key: 'sleep_time', block: 'lifestyle', kind: 'time', prompt: 'When do you usually go to sleep?', critical: true },
      { key: 'typical_day', block: 'lifestyle', kind: 'text', prompt: 'Describe a typical day, roughly.', optional: true, placeholder: 'e.g. 8-15 college, 16-18 gym, evening free' },
      {
        key: 'distractions', block: 'lifestyle', kind: 'multi', prompt: 'What usually steals your time?',
        options: [
          { id: 'social_media', label: 'Social media' }, { id: 'short_videos', label: 'Short videos' }, { id: 'games', label: 'Games' },
          { id: 'phone', label: 'Phone / messages' }, { id: 'tv', label: 'TV / streaming' }, { id: 'people', label: 'People around me' },
          { id: 'noise', label: 'Noise / no place to work' }, { id: 'poor_sleep', label: 'Poor sleep' }, { id: 'overthinking', label: 'Overthinking' },
          { id: 'other', label: 'Other' },
        ],
      },
      { key: 'obligations', block: 'lifestyle', kind: 'text', prompt: 'Anything that regularly breaks your plans?', help: 'Shifts, health, family duties, exams.', optional: true },
    ],
  },
  {
    id: 'planning',
    title: 'How you want to be managed',
    subtitle: 'You stay in control; this only sets the tone.',
    questions: [
      {
        key: 'planning_style', block: 'planning', kind: 'single', prompt: 'How strict should the plan be?', critical: true,
        options: [
          { id: 'strict', label: 'Strict', hint: 'Challenge me when I skip something important' },
          { id: 'balanced', label: 'Balanced', hint: 'Structure with room to breathe' },
          { id: 'flexible', label: 'Flexible', hint: 'Suggest, do not push' },
        ],
      },
      { key: 'strictness', block: 'planning', kind: 'scale', prompt: 'How firmly should the mentor push?', scale: { min: 0, max: 10, minLabel: 'Gentle', maxLabel: 'Firm' } },
      { key: 'free_time_desired', block: 'planning', kind: 'number', prompt: 'How much free time do you want protected each day?', unit: 'hours', critical: true, placeholder: 'e.g. 1.5' },
      {
        key: 'reminder_attitude', block: 'planning', kind: 'single', prompt: 'How do you feel about reminders?',
        options: [{ id: 'none', label: 'Minimal' }, { id: 'gentle', label: 'Gentle' }, { id: 'firm', label: 'Firm' }],
      },
      { key: 'planning_history', block: 'planning', kind: 'text', prompt: 'What has failed in previous attempts?', help: 'Knowing this prevents repeating it.', optional: true },
    ],
  },
  {
    id: 'career_finance',
    title: 'Work and money',
    subtitle: 'No strategy is assumed here — you choose the direction.',
    questions: [
      {
        key: 'career_direction', block: 'career_finance', kind: 'multi', prompt: 'Which of these do you actually want?', critical: true,
        options: [
          { id: 'stable_career', label: 'A stable career' }, { id: 'high_income', label: 'A high income' }, { id: 'own_business', label: 'My own business' },
          { id: 'investments', label: 'Investing' }, { id: 'multiple_incomes', label: 'Several income sources' }, { id: 'financial_independence', label: 'Financial independence' },
          { id: 'creative_career', label: 'A creative career' }, { id: 'academia', label: 'Science / academia' }, { id: 'public_service', label: 'Public service' },
          { id: 'undecided', label: 'Not decided yet' }, { id: 'other', label: 'Other' },
        ],
      },
      {
        key: 'financial_situation', block: 'career_finance', kind: 'single', prompt: 'How would you describe your finances now?', optional: true,
        options: [{ id: 'tight', label: 'Tight' }, { id: 'stable', label: 'Stable' }, { id: 'comfortable', label: 'Comfortable' }, PREFER_NOT_TO_SAY],
      },
      { key: 'risk_tolerance', block: 'career_finance', kind: 'scale', prompt: 'How much risk are you willing to take?', scale: { min: 1, max: 5, minLabel: 'Very cautious', maxLabel: 'Very bold' } },
      { key: 'capital_available', block: 'career_finance', kind: 'number', prompt: 'How much money could you put into this (if any)?', unit: 'your currency', optional: true },
      { key: 'income_expectation', block: 'career_finance', kind: 'text', prompt: 'What would "earning well" mean for you, concretely?', optional: true, help: 'A number, a lifestyle, or freedom from something.', critical: true },
    ],
  },
];

export const ALL_QUESTIONS: Question[] = QUESTIONNAIRE.flatMap((b) => b.questions);

export function findQuestion(key: string): Question | undefined {
  return ALL_QUESTIONS.find((q) => q.key === key);
}

export function questionLabel(key: string, answer: unknown): string {
  const question = findQuestion(key);
  if (!question) return String(answer ?? '');
  if (question.kind === 'single' || question.kind === 'multi') {
    const ids = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    return ids.map((id) => question.options?.find((o) => o.id === id)?.label ?? id).join(', ');
  }
  return String(answer ?? '');
}
