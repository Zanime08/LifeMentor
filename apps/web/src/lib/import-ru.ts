import type { ImportWarning } from '@lifementor/core';

/**
 * What the user reads before importing an archive (phase-20 i18n).
 *
 * The engine describes the file in English, for the log and for support. These sentences are the only
 * thing standing between the person and «Заменить всё», so they are worded here — including the ones
 * that say part of the archive will *not* arrive.
 */
export function importWarningText(warning: ImportWarning): string {
  switch (warning.code) {
    case 'newer_format':
      return `Файл создан более новым LifeMentor (формат v${warning.found ?? '?'}), а эта версия понимает v${warning.supported ?? '?'}. Часть данных может не перенестись.`;
    case 'unknown_entity':
      return `Неизвестный раздел «${warning.entity ?? '?'}» — пропущен. Обновите приложение, если файл создан новой версией.`;
    case 'not_a_list':
      return `Раздел «${warning.entity ?? '?'}» повреждён (ожидался список записей) — пропущен.`;
    case 'unknown_settings_group':
      return `Настройки «${warning.entity ?? '?'}» эта версия не знает — они не перенесутся.`;
    case 'invalid_settings':
      return `Настройки «${warning.entity ?? '?'}» из файла не читаются — они будут пропущены.`;
    default:
      return `Предупреждение при чтении файла: ${warning.raw}`;
  }
}

/** Human names for the entity types an archive carries. */
const ENTITY_RU: Record<string, string> = {
  goal: 'цели', task: 'задачи', calendar_event: 'события календаря', project: 'проекты',
  skill: 'навыки', skill_evidence: 'подтверждения навыков', skill_review: 'оценки навыков',
  learning_path: 'пути обучения', learning_topic: 'темы обучения', learning_progress: 'прогресс обучения',
  memory: 'память', knowledge_node: 'узлы знаний', knowledge_edge: 'связи знаний',
  progress_snapshot: 'снимки прогресса', review: 'обзоры', day_plan: 'планы дня', task_history: 'история задач',
  profile_field: 'поля профиля', user_model: 'модель пользователя', strategy: 'стратегия',
  strategy_option: 'варианты стратегии', strategy_change: 'история изменений',
  news_item: 'новости', notification: 'уведомления', notification_preference: 'настройки уведомлений',
  conversation: 'беседы', conversation_message: 'сообщения бесед', journal: 'журнал изменений',
  onboarding_session: 'прохождение знакомства', onboarding_answer: 'ответы знакомства',
  knowledge_gap: 'пробелы в знаниях', insight: 'инсайты', habit: 'привычки',
  focus_session: 'сессии фокуса', tag: 'теги', backup: 'резервные копии', setting: 'настройки',
};

/** The archive's own name for a section, or a readable fallback for a section we do not know. */
export function entityRu(entityType: string): string {
  return ENTITY_RU[entityType] ?? entityType.replace(/_/g, ' ');
}
