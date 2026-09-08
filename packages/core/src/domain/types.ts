/**
 * Domain model — the shape of every persisted entity.
 * Field names match the SQLite columns exactly (no mapping layer, no drift).
 */

// ─────────────────────────── shared enums & mixins ───────────────────────────
export type SyncState = 'local' | 'pending' | 'synchronized' | 'conflict';
export type Actor = 'user' | 'ai' | 'system' | 'sync' | 'import';
export type FactSource = 'user_provided' | 'ai_inferred' | 'system_observed' | 'unknown';
export type Confidence = 'confirmed' | 'inferred' | 'uncertain';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Energy = 'low' | 'medium' | 'high';
export type Horizon = 'long' | 'medium' | 'short' | 'daily';
export type StrategyHorizon = '3-5y' | '1y' | '3mo' | '1mo' | '1w' | 'today' | 'now';

/** Columns every synced entity has (req. 62). */
export interface EntityMeta {
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  deleted: 0 | 1;
  sync_state: SyncState;
}

export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
export const PRIORITY_WEIGHT: Record<Priority, number> = { P0: 1, P1: 0.75, P2: 0.45, P3: 0.2 };
export const ENERGY_COST: Record<Energy, number> = { low: 0.25, medium: 0.55, high: 0.9 };
export const HORIZON_WEIGHT: Record<Horizon, number> = { long: 0.5, medium: 0.75, short: 0.95, daily: 1 };

// ─────────────────────────── account / settings ───────────────────────────
export interface Account extends EntityMeta {
  user_id: string;
  email: string;
  display_name: string | null;
  plan: string;
  server_url: string | null;
  last_login_at: string | null;
}

export interface SessionRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: string | null;
  device_id: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  platform: 'windows' | 'android' | 'web' | 'server' | string;
  is_current: 0 | 1;
  registered_at: string;
  last_seen_at: string;
}

export interface SettingRow extends Omit<EntityMeta, 'id'> {
  key: string;
  value: string; // JSON-encoded
  category: string;
  scope: 'synced' | 'local';
}

export interface AppStateRow { key: string; value: string; updated_at: string }

// ─────────────────────────── onboarding & user model ───────────────────────────
export type OnboardingStage =
  | 'questionnaire' | 'analysis' | 'interview' | 'confirmation' | 'goals' | 'skills' | 'plan' | 'done';
export type OnboardingStatus = 'in_progress' | 'awaiting_interview' | 'awaiting_confirmation' | 'completed' | 'abandoned';

export interface OnboardingSession extends EntityMeta {
  id: string;
  status: OnboardingStatus;
  stage: OnboardingStage;
  started_at: string;
  completed_at: string | null;
  answers_count: number;
  model_json: string | null;
}

export type AnswerKind = 'text' | 'single' | 'multi' | 'scale' | 'time' | 'date';

export interface OnboardingAnswer {
  id: string;
  session_id: string;
  block: string;
  question_key: string;
  answer_kind: AnswerKind;
  answer: string; // JSON-encoded value
  label: string | null;
  source: FactSource;
  position: number;
  created_at: string;
  updated_at: string;
}

export type GapType =
  | 'missing_data' | 'contradiction' | 'vague_goal' | 'goal_conflict'
  | 'skill_ambiguity' | 'unknown_constraint' | 'missing_horizon';

export interface InterviewQuestion extends EntityMeta {
  id: string;
  session_id: string;
  gap_type: GapType;
  target: string | null;
  question: string;
  rationale: string | null;
  importance: number;
  status: 'pending' | 'asked' | 'answered' | 'skipped';
  answer: string | null;
  changed_model: 0 | 1;
  asked_at: string | null;
  answered_at: string | null;
}

export type ProfileSection =
  | 'PROFILE' | 'VALUES' | 'GOALS' | 'CONSTRAINTS' | 'INTERESTS' | 'SKILLS' | 'KNOWLEDGE'
  | 'PROJECTS' | 'PREFERENCES' | 'TIME_AVAILABILITY' | 'MOTIVATION_FACTORS' | 'DISTRACTIONS'
  | 'LEARNING_PREFERENCES' | 'CAREER_DIRECTION' | 'FINANCIAL_DIRECTION';

export const PROFILE_SECTIONS: ProfileSection[] = [
  'PROFILE', 'VALUES', 'GOALS', 'CONSTRAINTS', 'INTERESTS', 'SKILLS', 'KNOWLEDGE', 'PROJECTS',
  'PREFERENCES', 'TIME_AVAILABILITY', 'MOTIVATION_FACTORS', 'DISTRACTIONS', 'LEARNING_PREFERENCES',
  'CAREER_DIRECTION', 'FINANCIAL_DIRECTION',
];

export interface ProfileField extends EntityMeta {
  id: string;
  section: ProfileSection;
  field_key: string;
  label: string | null;
  value: string; // JSON-encoded
  value_kind: 'text' | 'number' | 'bool' | 'list' | 'json' | 'scale';
  source: FactSource;
  confidence: Confidence;
  evidence: string | null;
  importance: number;
}

export interface UserModelSnapshot { id: string; trigger: string; model_json: string; created_at: string }

// ─────────────────────────── goals & strategy ───────────────────────────
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned' | 'archived';

export interface GoalMetric { kind: 'number' | 'boolean' | 'habit'; target?: number; current?: number; unit?: string }

export interface Goal extends EntityMeta {
  id: string;
  title: string;
  description: string | null;
  area: string | null;
  horizon: Horizon;
  status: GoalStatus;
  priority: Priority;
  parent_id: string | null;
  motivation: string | null;
  metric_json: string | null;
  progress: number;
  start_date: string | null;
  target_date: string | null;
  completed_at: string | null;
  archived_at: string | null;
  strict: 0 | 1;
}

export interface GoalRelationship {
  id: string;
  parent_goal_id: string;
  child_goal_id: string;
  relation_type: 'supports' | 'requires' | 'conflicts_with';
  note: string | null;
  created_at: string;
}

export interface GoalReview {
  id: string;
  goal_id: string;
  reviewed_at: string;
  findings_json: string | null;
  recommendation: string | null;
  decision: 'keep' | 'adjust' | 'pause' | 'archive' | 'split' | null;
  status_before: string | null;
  status_after: string | null;
  created_at: string;
}

export interface StrategyItem extends EntityMeta {
  id: string;
  horizon: StrategyHorizon;
  title: string;
  description: string | null;
  goal_id: string | null;
  status: 'active' | 'done' | 'dropped';
  position: number;
  review_at: string | null;
}

/** Immutable evolution history (req. 81). */
export interface StrategyChange {
  id: string;
  entity_type: string;
  entity_id: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  actor: Actor;
  created_at: string;
}

// ─────────────────────────── skills & knowledge ───────────────────────────
export type AssessmentKind = 'test' | 'practice' | 'project' | 'exam' | 'task' | 'explanation' | 'real_result';

export interface Skill extends EntityMeta {
  id: string;
  name: string;
  domain: string | null;
  description: string | null;
  level: number; // 0..100
  confidence: Confidence;
  self_rating: number | null;
  weak_points: string | null; // JSON array
  evidence_json: string | null; // JSON array
  goal_id: string | null;
  last_assessment_at: string | null;
  next_assessment_at: string | null;
}

export interface SkillAssessment {
  id: string;
  skill_id: string;
  kind: AssessmentKind;
  score: number | null;
  level_before: number | null;
  level_after: number | null;
  evidence_type: string | null;
  evidence_ref: string | null;
  notes: string | null;
  assessed_at: string;
  created_at: string;
}

export interface KnowledgeNode extends EntityMeta {
  id: string;
  title: string;
  domain: string | null;
  summary: string | null;
  mastery: number;
  status: 'unknown' | 'learning' | 'practiced' | 'mastered' | 'gap';
  parent_id: string | null;
}

export interface KnowledgeRelationship {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relation: 'prerequisite' | 'related' | 'part_of' | 'applies';
  weight: number;
  note: string | null;
  created_at: string;
}

export interface KnowledgeNodeLink {
  id: string;
  node_id: string;
  entity_type: 'goal' | 'skill' | 'learning_topic' | 'project' | 'task';
  entity_id: string;
  created_at: string;
}

// ─────────────────────────── projects ───────────────────────────
export type ProjectStatus = 'idea' | 'active' | 'paused' | 'done' | 'archived' | 'cancelled';

export interface Project extends EntityMeta {
  id: string;
  title: string;
  description: string | null;
  goal_id: string | null;
  status: ProjectStatus;
  priority: Priority;
  start_date: string | null;
  deadline: string | null;
  progress: number;
  health: 'on_track' | 'at_risk' | 'stalled' | 'blocked' | null;
  last_activity_at: string | null;
}

export interface ProjectMilestone extends EntityMeta {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  position: number;
  due_date: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  weight: number;
  completed_at: string | null;
}

export interface ProjectSkill {
  id: string; project_id: string; skill_id: string; role: 'builds' | 'requires'; created_at: string;
}

// ─────────────────────────── learning ───────────────────────────
export interface LearningPath extends EntityMeta {
  id: string;
  title: string;
  description: string | null;
  skill_id: string | null;
  goal_id: string | null;
  target_level: number | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  progress: number;
}

export interface LearningTopic extends EntityMeta {
  id: string;
  path_id: string;
  title: string;
  summary: string | null;
  outcome: string | null;
  position: number;
  depends_on: string | null; // JSON array of topic ids
  estimated_minutes: number;
  status: 'pending' | 'available' | 'in_progress' | 'done' | 'skipped';
  resources_json: string | null;
  progress: number;
  completed_at: string | null;
}

export interface LearningProgress {
  id: string;
  topic_id: string | null;
  path_id: string | null;
  kind: 'study' | 'practice' | 'test' | 'recall' | 'explanation' | 'project';
  minutes: number;
  score: number | null;
  notes: string | null;
  at: string;
  created_at: string;
}

export interface LearningReview extends EntityMeta {
  id: string;
  topic_id: string;
  card_key: string;
  prompt: string;
  answer: string | null;
  due_at: string;
  interval_days: number;
  ease: number;
  repetitions: number;
  lapses: number;
  last_reviewed_at: string | null;
  status: 'active' | 'mastered' | 'suspended';
}

// ─────────────────────────── tasks & calendar ───────────────────────────
export type TaskStatus = 'todo' | 'scheduled' | 'in_progress' | 'done' | 'cancelled' | 'postponed';
export type TaskKind = 'generic' | 'learning' | 'practice' | 'review' | 'project' | 'health' | 'errand' | 'work';
export type SkipReason = 'unexpected_event' | 'lack_of_time' | 'fatigue' | 'illness' | 'procrastination' | 'other';

export const SKIP_REASONS: SkipReason[] = ['unexpected_event', 'lack_of_time', 'fatigue', 'illness', 'procrastination', 'other'];

export interface Task extends EntityMeta {
  id: string;
  title: string;
  notes: string | null;
  kind: TaskKind;
  status: TaskStatus;
  priority: Priority;
  energy: Energy;
  estimated_minutes: number;
  actual_minutes: number;
  goal_id: string | null;
  project_id: string | null;
  skill_id: string | null;
  learning_topic_id: string | null;
  due_date: string | null;
  due_time: string | null;
  scheduled_date: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  completed_at: string | null;
  postponed_count: number;
  postpone_reason: SkipReason | null;
  strict: 0 | 1;
  recurrence: string | null;
  last_done_at: string | null;
  position: number;
}

export interface TaskHistory {
  id: string;
  task_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  reason: SkipReason | null;
  note: string | null;
  actor: Actor;
  at: string;
  created_at: string;
}

export type EventKind = 'class' | 'work' | 'meeting' | 'commute' | 'errand' | 'training' | 'social' | 'health' | 'exam' | 'free' | 'other';
export type EventPriority = 'critical' | 'normal' | 'flexible';

export interface CalendarEvent extends EntityMeta {
  id: string;
  title: string;
  kind: EventKind;
  location: string | null;
  notes: string | null;
  day_key: string;
  starts_at: string;
  ends_at: string;
  all_day: 0 | 1;
  priority: EventPriority;
  source: 'manual' | 'ai' | 'import' | 'external';
  reminder_minutes: number | null;
}

// ─────────────────────────── memory ───────────────────────────
export type MemoryKind = 'fact' | 'preference' | 'goal_change' | 'decision' | 'event' | 'insight' | 'behavior' | 'skill_evidence';

export interface Memory extends EntityMeta {
  id: string;
  kind: MemoryKind;
  section: ProfileSection | string | null;
  content: string;
  importance: number;
  confidence: Confidence;
  source: FactSource;
  entity_type: string | null;
  entity_id: string | null;
  tags: string | null; // JSON array
  embedding: string | null; // JSON array of floats
  valid_from: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  needs_confirmation: 0 | 1;
  use_count: number;
  last_used_at: string | null;
}

export interface MemorySource {
  id: string; memory_id: string; source_type: string; source_id: string | null; note: string | null; created_at: string;
}

// ─────────────────────────── conversations ───────────────────────────
export interface Conversation extends EntityMeta {
  id: string;
  title: string | null;
  kind: 'mentor' | 'onboarding' | 'interview' | 'review';
  summary: string | null;
  started_at: string;
  last_message_at: string | null;
  message_count: number;
  tokens_total: number;
}

export interface Message extends EntityMeta {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: string | null;
  tool_name: string | null;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  latency_ms: number | null;
}

// ─────────────────────────── news ───────────────────────────
export type NewsCategory = 'world' | 'technology' | 'ai' | 'economy' | 'business' | 'science' | 'geopolitics' | 'programming';
export type NewsUrgency = 'urgent' | 'digest' | 'none';

export const NEWS_CATEGORIES: NewsCategory[] = ['world', 'technology', 'ai', 'economy', 'business', 'science', 'geopolitics', 'programming'];

export interface NewsSource extends EntityMeta {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'api';
  category: NewsCategory;
  language: string;
  enabled: 0 | 1;
  last_fetched_at: string | null;
  etag: string | null;
}

export interface NewsItem extends EntityMeta {
  id: string;
  source_id: string | null;
  external_id: string | null;
  url: string | null;
  title: string;
  summary: string | null;
  what_happened: string | null;
  why_it_matters: string | null;
  context: string | null;
  impact: string | null;
  category: NewsCategory;
  urgency: NewsUrgency;
  relevance: number;
  day_key: string | null;
  published_at: string | null;
  fetched_at: string;
  read_at: string | null;
  saved_at: string | null;
  structured: 0 | 1;
}

// ─────────────────────────── notifications ───────────────────────────
export type NotificationType =
  | 'daily_plan' | 'schedule_start' | 'task_reminder' | 'learning_review' | 'important_news'
  | 'goal_review' | 'project_deadline' | 'mentor_message' | 'daily_digest';

export const NOTIFICATION_TYPES: NotificationType[] = [
  'daily_plan', 'schedule_start', 'task_reminder', 'learning_review', 'important_news',
  'goal_review', 'project_deadline', 'mentor_message', 'daily_digest',
];

export interface Notification extends EntityMeta {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  context_json: string | null;
  importance: number;
  channel: 'local' | 'push' | 'in_app';
  scheduled_at: string;
  delivered_at: string | null;
  read_at: string | null;
  cancelled_at: string | null;
  action_type: string | null;
  entity_type: string | null;
  entity_id: string | null;
  budget_day: string | null;
  dedupe_key: string | null;
}

export interface NotificationPreference extends Omit<EntityMeta, 'id'> {
  type: NotificationType | '*';
  enabled: 0 | 1;
  channels: string; // JSON array
  quiet_start: string | null;
  quiet_end: string | null;
  daily_budget: number;
}

// ─────────────────────────── progress / reviews (derived) ───────────────────────────
export interface ProgressSnapshot {
  id: string; scope: 'day' | 'week' | 'month'; period_key: string; metrics_json: string; created_at: string;
}

export interface DailySnapshot extends EntityMeta {
  id: string;
  day: string;
  completed_json: string | null;
  pending_json: string | null;
  schedule_changes_json: string | null;
  progress_json: string | null;
  achievements_json: string | null;
  goal_changes_json: string | null;
  events_json: string | null;
  projects_json: string | null;
  learning_json: string | null;
  metrics_json: string | null;
  summary: string | null;
}

export interface WeeklyReview extends EntityMeta {
  id: string;
  week_start: string;
  went_well: string | null;
  went_wrong: string | null;
  changed: string | null;
  blockers: string | null;
  improved: string | null;
  next_week: string | null;
  analysis: string | null;
  patterns: string | null;
  metrics_json: string | null;
}

export interface MonthlyReview extends EntityMeta {
  id: string;
  month: string;
  goals_json: string | null;
  skills_json: string | null;
  projects_json: string | null;
  priority_changes: string | null;
  strategy_proposal: string | null;
  metrics_json: string | null;
}

export interface BehaviorSignal {
  id: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  value_json: string;
  weight: number;
  observed_at: string;
  created_at: string;
}

export interface PersonalizationEntry {
  key: string;
  value_json: string;
  evidence_count: number;
  confidence: Confidence;
  updated_at: string;
}

// ─────────────────────────── sync & audit ───────────────────────────
export type SyncStatus = 'pending' | 'in_flight' | 'synchronized' | 'conflict' | 'failed';

export interface SyncOperation {
  operation_id: string;
  entity_type: string;
  entity_id: string;
  operation_type: 'create' | 'update' | 'delete';
  payload: string; // JSON
  base_version: number;
  version: number;
  priority: number;
  device_id: string | null;
  attempts: number;
  last_error: string | null;
  sync_status: SyncStatus;
  created_at: string;
  updated_at: string;
}

export interface SyncCursor {
  entity_type: string; last_pulled_seq: string | null; last_pushed_at: string | null; updated_at: string;
}

export interface SyncConflict {
  id: string;
  entity_type: string;
  entity_id: string;
  field: string | null;
  local_payload: string;
  remote_payload: string;
  base_version: number;
  server_version: number;
  critical: 0 | 1;
  resolution: 'merged' | 'local_wins' | 'remote_wins' | 'user_choice' | 'delete_wins' | null;
  resolved_at: string | null;
  resolved_by: string | null;
  detected_at: string;
  created_at: string;
}

export interface ChangeLogEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  actor: Actor;
  reason: string | null;
  correlation_id: string | null;
  at: string;
}

export interface BackupRecord {
  id: string;
  kind: 'auto' | 'manual' | 'pre_migration' | 'pre_import' | 'pre_account_delete' | 'export';
  format: 'sqlite' | 'json';
  path: string | null;
  checksum: string | null;
  size_bytes: number | null;
  entity_counts: string | null;
  note: string | null;
  status: 'ok' | 'failed' | 'restored';
  created_at: string;
}

// ─────────────────────────── planner output (not persisted as-is) ───────────────────────────
export interface PlannedSlot {
  start: string;              // local "HH:MM"
  end: string;
  kind: 'event' | 'task' | 'break' | 'free';
  title: string;
  taskId?: string;
  eventId?: string;
  priority?: Priority;
  energy?: Energy;
  note?: string;
  immovable?: boolean;
}

export interface DayPlan {
  day: string;
  slots: PlannedSlot[];
  deferred: { task_id: string; title: string; reason: string }[];
  focus_minutes: number;
  free_minutes: number;
  fixed_minutes: number;
  capacity_minutes: number;
  overload: boolean;
  warnings: string[];
  generated_at: string;
}
