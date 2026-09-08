import type { Database } from './database';
import { EntityRepo, localSpec, syncedSpec } from './repo';
import type {
  Account, AppStateRow, BackupRecord, BehaviorSignal, CalendarEvent, ChangeLogEntry, Conversation,
  DailySnapshot, DeviceRow, Goal, GoalRelationship, GoalReview, InterviewQuestion, KnowledgeNode,
  KnowledgeNodeLink, KnowledgeRelationship, LearningPath, LearningProgress, LearningReview, LearningTopic,
  Memory, MemorySource, Message, MonthlyReview, NewsItem, NewsSource, Notification, NotificationPreference,
  OnboardingAnswer, OnboardingSession, PersonalizationEntry, ProfileField, ProgressSnapshot, Project,
  ProjectMilestone, ProjectSkill, SessionRow, SettingRow, Skill, SkillAssessment, StrategyChange,
  StrategyItem, SyncConflict, SyncCursor, SyncOperation, Task, TaskHistory, UserModelSnapshot, WeeklyReview,
} from '../domain/types';

/**
 * All repositories for one database. Services receive this object instead of the Database,
 * which keeps SQL in exactly one layer (and makes "the AI has no SQL access" structurally true).
 *
 * syncPriority: goals/profile/tasks/events are pushed before news/conversations, so a limited
 * connection flushes what matters first.
 */
export function createRepos(db: Database) {
  return {
    db,

    // meta / account
    account: new EntityRepo<Account>(db, { ...syncedSpec('account', 'account', 10), pk: 'user_id' }),
    session: new EntityRepo<SessionRow>(db, { ...localSpec('session', 'session'), pk: 'user_id' }),
    devices: new EntityRepo<DeviceRow>(db, { ...localSpec('devices', 'device'), pk: 'id' }),
    settings: new EntityRepo<SettingRow>(db, { ...syncedSpec('settings', 'setting', 5), pk: 'key' }),
    appState: new EntityRepo<AppStateRow>(db, { ...localSpec('app_state', 'app_state'), pk: 'key' }),

    // onboarding & user model
    onboardingSessions: new EntityRepo<OnboardingSession>(db, syncedSpec('onboarding_sessions', 'onboarding_session', 9)),
    onboardingAnswers: new EntityRepo<OnboardingAnswer>(db, localSpec('onboarding_answers', 'onboarding_answer')),
    interviewQuestions: new EntityRepo<InterviewQuestion>(db, syncedSpec('interview_questions', 'interview_question', 9)),
    profileFields: new EntityRepo<ProfileField>(db, syncedSpec('profile_fields', 'profile_field', 9)),
    userModelSnapshots: new EntityRepo<UserModelSnapshot>(db, localSpec('user_model_snapshots', 'user_model_snapshot')),

    // goals & strategy
    goals: new EntityRepo<Goal>(db, syncedSpec('goals', 'goal', 8)),
    goalRelationships: new EntityRepo<GoalRelationship>(db, localSpec('goal_relationships', 'goal_relationship')),
    goalReviews: new EntityRepo<GoalReview>(db, localSpec('goal_reviews', 'goal_review')),
    strategyItems: new EntityRepo<StrategyItem>(db, syncedSpec('strategy_items', 'strategy_item', 7)),
    strategyChanges: new EntityRepo<StrategyChange>(db, localSpec('strategy_changes', 'strategy_change')),

    // skills & knowledge
    skills: new EntityRepo<Skill>(db, syncedSpec('skills', 'skill', 6)),
    skillAssessments: new EntityRepo<SkillAssessment>(db, localSpec('skill_assessments', 'skill_assessment')),
    knowledgeNodes: new EntityRepo<KnowledgeNode>(db, syncedSpec('knowledge_nodes', 'knowledge_node', 4)),
    knowledgeRelationships: new EntityRepo<KnowledgeRelationship>(db, localSpec('knowledge_relationships', 'knowledge_relationship')),
    knowledgeNodeLinks: new EntityRepo<KnowledgeNodeLink>(db, localSpec('knowledge_node_links', 'knowledge_node_link')),

    // projects
    projects: new EntityRepo<Project>(db, syncedSpec('projects', 'project', 7)),
    projectMilestones: new EntityRepo<ProjectMilestone>(db, syncedSpec('project_milestones', 'project_milestone', 6)),
    projectSkills: new EntityRepo<ProjectSkill>(db, localSpec('project_skills', 'project_skill')),

    // learning
    learningPaths: new EntityRepo<LearningPath>(db, syncedSpec('learning_paths', 'learning_path', 5)),
    learningTopics: new EntityRepo<LearningTopic>(db, syncedSpec('learning_topics', 'learning_topic', 5)),
    learningProgress: new EntityRepo<LearningProgress>(db, localSpec('learning_progress', 'learning_progress')),
    learningReviews: new EntityRepo<LearningReview>(db, syncedSpec('learning_reviews', 'learning_review', 5)),

    // tasks & calendar
    tasks: new EntityRepo<Task>(db, syncedSpec('tasks', 'task', 8)),
    taskHistory: new EntityRepo<TaskHistory>(db, localSpec('task_history', 'task_history')),
    calendarEvents: new EntityRepo<CalendarEvent>(db, syncedSpec('calendar_events', 'calendar_event', 8)),

    // memory
    memories: new EntityRepo<Memory>(db, syncedSpec('memories', 'memory', 6)),
    memorySources: new EntityRepo<MemorySource>(db, localSpec('memory_sources', 'memory_source')),

    // conversations
    conversations: new EntityRepo<Conversation>(db, syncedSpec('conversations', 'conversation', 3)),
    messages: new EntityRepo<Message>(db, syncedSpec('messages', 'message', 3)),

    // news
    newsSources: new EntityRepo<NewsSource>(db, syncedSpec('news_sources', 'news_source', 1)),
    newsItems: new EntityRepo<NewsItem>(db, syncedSpec('news_items', 'news_item', 1)),

    // notifications
    notifications: new EntityRepo<Notification>(db, syncedSpec('notifications', 'notification', 4)),
    notificationPreferences: new EntityRepo<NotificationPreference>(db, { ...syncedSpec('notification_preferences', 'notification_preference', 5), pk: 'type' }),

    // progress / reviews / personalization (derived)
    progressSnapshots: new EntityRepo<ProgressSnapshot>(db, localSpec('progress_snapshots', 'progress_snapshot')),
    dailySnapshots: new EntityRepo<DailySnapshot>(db, syncedSpec('daily_snapshots', 'daily_snapshot', 2)),
    weeklyReviews: new EntityRepo<WeeklyReview>(db, syncedSpec('weekly_reviews', 'weekly_review', 2)),
    monthlyReviews: new EntityRepo<MonthlyReview>(db, syncedSpec('monthly_reviews', 'monthly_review', 2)),
    behaviorSignals: new EntityRepo<BehaviorSignal>(db, localSpec('behavior_signals', 'behavior_signal')),
    personalization: new EntityRepo<PersonalizationEntry>(db, { ...localSpec('personalization_profile', 'personalization'), pk: 'key' }),

    // sync & audit
    syncQueue: new EntityRepo<SyncOperation>(db, { ...localSpec('sync_queue', 'sync_operation'), pk: 'operation_id' }),
    syncCursors: new EntityRepo<SyncCursor>(db, { ...localSpec('sync_cursors', 'sync_cursor'), pk: 'entity_type' }),
    syncConflicts: new EntityRepo<SyncConflict>(db, localSpec('sync_conflicts', 'sync_conflict')),
    changeLog: new EntityRepo<ChangeLogEntry>(db, localSpec('change_log', 'change_log')),
    backups: new EntityRepo<BackupRecord>(db, localSpec('backups', 'backup')),

    /** Every synced repository, in push-priority order — used by SyncEngine and export/import. */
    syncedRepos(): EntityRepo<object>[] {
      return [
        this.account, this.settings, this.profileFields, this.onboardingSessions, this.interviewQuestions,
        this.goals, this.strategyItems, this.skills, this.projects, this.projectMilestones,
        this.learningPaths, this.learningTopics, this.learningReviews, this.tasks, this.calendarEvents,
        this.memories, this.conversations, this.messages, this.newsSources, this.newsItems,
        this.notifications, this.notificationPreferences, this.dailySnapshots, this.weeklyReviews,
        this.monthlyReviews, this.knowledgeNodes,
      ];
    },

    /** Every table that holds user data (account deletion, import replace mode). */
    allRepos(): EntityRepo<object>[] {
      return [
        ...this.syncedRepos(),
        this.session, this.devices, this.appState, this.onboardingAnswers, this.userModelSnapshots,
        this.goalRelationships, this.goalReviews, this.strategyChanges, this.skillAssessments,
        this.knowledgeRelationships, this.knowledgeNodeLinks, this.projectSkills, this.learningProgress,
        this.taskHistory, this.memorySources, this.progressSnapshots, this.behaviorSignals,
        this.personalization, this.syncQueue, this.syncCursors, this.syncConflicts, this.changeLog,
        this.backups,
      ];
    },

    byEntityType(entityType: string): EntityRepo<object> | undefined {
      return this.allRepos().find((r) => r.entityType === entityType);
    },
  };
}

export type Repos = ReturnType<typeof createRepos>;
