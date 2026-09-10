import type { ConfirmationRequest } from '@lifementor/core';

/**
 * The question before a dangerous action, in the user's words (phase-20 i18n).
 *
 * The engine's registry refuses to run a destructive or surprising tool unless the user has approved
 * *that exact call* — deleting an event, cancelling a task, archiving a goal, raising a task to P0,
 * saving a confirmed fact about the person, building a plan for another day. The refusal carries a
 * question written for the model, in English
 * («Delete the event "Экзамен" from 2026-09-10? This cannot be undone.»), and the interface used to
 * show that sentence verbatim — or, more often, nothing at all, because it ignored
 * `turn.confirmations` completely.
 *
 * The wording lives here, next to the tool labels, and a drift test reads the registry: every tool
 * with a `confirm` policy must be wordable, or the person is asked a question in a language they may
 * not read before something irreversible happens.
 */
export function confirmationText(request: ConfirmationRequest, toolLabel?: string): string {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof args[key] === 'string' ? String(args[key]) : '');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The model may name a task by its id — the user must never be asked to approve a UUID.
  const quote = (value: string, fallback: string): string => (!value || uuid.test(value) ? fallback : `«${value}»`);
  const label = toolLabel ?? request.tool;

  switch (request.tool) {
    case 'update_task':
      return `Поднять задачу ${quote(text('task'), 'из чата')} до P0 — это высший приоритет. Продолжить?`;
    case 'update_goal':
      return args.status === 'archived'
        ? `Архивировать цель ${quote(text('goal'), 'из чата')}? Она перестанет участвовать в планировании.`
        : `Закрыть цель ${quote(text('goal'), 'из чата')}? Она перестанет участвовать в планировании.`;
    case 'delete_calendar_event':
      return `Удалить событие ${quote(text('title'), 'из чата')}${text('day') ? ` (${text('day')})` : ''}? Это необратимо.`;
    case 'cancel_task':
      return `Отменить задачу ${quote(text('task'), 'из чата')}? Она уйдёт из плана.`;
    case 'create_learning_path':
      return `Создать путь обучения из ${String((args.topics as unknown[] | undefined)?.length ?? '?')} тем?`;
    case 'assess_skill':
      return `Записать оценку навыка ${quote(text('skill'), 'из чата')}? Уровень меняется по доказательству и виден в профиле.`;
    case 'save_memory':
      return `Запомнить ${quote(text('content'), 'эту запись')} как подтверждённый факт о вас?`;
    case 'delete_memory':
      return `Удалить это из памяти навсегда?${text('reason') ? ` Причина: ${text('reason')}.` : ''}`;
    case 'plan_day':
      return text('day')
        ? `Построить план на ${text('day')}? Он переставит задачи вокруг ваших событий.`
        : 'Построить план? Он переставит задачи вокруг ваших событий.';
    case 'update_user_model':
      return 'Часть полей — предположения ИИ, отмеченные как подтверждённые. Записать их в профиль?';
    default:
      // A tool from a newer build: the user still gets a readable question naming the action.
      return `Выполнить действие «${label}»? Проверьте, что оно действительно нужно.`;
  }
}
