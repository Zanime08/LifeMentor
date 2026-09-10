import type { ReviewItem } from '@lifementor/core';
import { fmtMinutes, plural } from './ru';

/**
 * Russian wording for review sentences (req. 77, 78).
 *
 * The engine decides *what* is worth saying and stores each sentence as a code plus the numbers
 * behind it; the wording lives here. Keeping the two apart is deliberate: the same review is read by
 * the AI context and by the JSON export in English, while the person reading the app gets their own
 * language — and no screen ever shows a raw `{"code":...}` blob or an English sentence.
 *
 * Every code the engine can emit must be handled below; `review-ru.test.ts` walks a real review and
 * fails if a code has no wording.
 */
export function reviewItemText(item: ReviewItem): string | null {
  const p = (item.params ?? {}) as Record<string, number | string>;
  const num = (key: string): number => Number(p[key] ?? 0);
  const str = (key: string): string => String(p[key] ?? '');
  switch (item.code) {
    // ── weekly: what went well ──────────────────────────────────────────
    case 'tasks_completed':
      return `Сделано задач: ${num('count')} · ${fmtMinutes(num('focusMinutes'))} в фокусе`;
    case 'learning_time':
      return `На обучение ушло ${fmtMinutes(num('minutes'))}`;
    case 'streak':
      return `Серия ${num('days')} ${plural(num('days'), 'день', 'дня', 'дней')} подряд`;
    case 'days_active':
      return `Активных дней: ${num('days')} из 7`;
    // ── weekly: what did not work ───────────────────────────────────────
    case 'postponed':
      return `Перенесено задач: ${num('count')}`;
    case 'completion_rate':
      return `Выполнено ${num('percent')}% запланированного`;
    case 'untouched_goals':
      // Emitted twice with different detail: as a fact (count only) and as a pattern (with the titles).
      return str('titles')
        ? `Целей без движения: ${num('count')} — ${str('titles')}.`
        : `Целей без движения: ${num('count')}`;
    // ── weekly: what the engine noticed ─────────────────────────────────
    case 'plan_too_heavy':
      return `Выполнено ${num('percent')}% из ${num('planned')} задач — план систематически тяжелее реальности.`;
    case 'best_hours':
      return `Работа около ${num('best')}:00 удаётся в ${num('bestRate')}% случаев, около ${num('worst')}:00 — только в ${num('worstRate')}%.`;
    case 'procrastination':
      return `«Прокрастинация» названа причиной ${num('count')} ${plural(num('count'), 'раз', 'раза', 'раз')} — посмотрите, что общего у этих задач.`;
    case 'estimate_overrun':
      return `Фактическое время превышало оценку примерно на ${num('percent')}%.`;
    case 'learning_behind':
      return `Обучение получило ${fmtMinutes(num('minutes'))} из ${fmtMinutes(num('target'))} недельной цели.`;
    case 'consistency':
      return `Активность ${num('days')}/7 дней — стабильность сейчас ваш главный сигнал.`;
    // ── weekly: next week ───────────────────────────────────────────────
    case 'cut_load':
      return `Срежьте дневную нагрузку примерно до ${fmtMinutes(num('minutes'))} и оставьте только P0/P1, пока выполнение не восстановится.`;
    case 'hardest_at_hour':
      return `Самое трудное ставьте на ${num('hour')}:00 — тогда процент завершения выше всего (${num('rate')}%).`;
    case 'pick_one_goal':
      return `Выберите ОДНУ из целей и дайте ей конкретную задачу на 30 минут: ${str('titles')}.`;
    case 'minimal_version':
      return `Для задач, которые откладываются, берите минимальную версию на 10 минут вместо полной.`;
    case 'schedule_learning':
      return `Поставьте обучение фиксированным блоком в календарь, а не «если останется время».`;
    case 'keep_structure':
      return `Структура работает — оставьте как есть.`;
    case 'smaller_plan':
      return `Меньше дневной план`;
    case 'time_of_day_fit':
      return `Учёт времени суток`;
    // ── monthly: priorities and strategy ────────────────────────────────
    case 'stale_goals':
      return `Целей без движения 30+ дней: ${num('count')} — ${str('titles')}. Решите: скорректировать, поставить на паузу или архивировать.`;
    case 'overdue_goals':
      return `Целей с прошедшей целевой датой: ${num('count')} — ${str('titles')}.`;
    case 'skill_assessments_due':
      return `Пора оценить навыки: ${str('names')}.`;
    case 'projects_need_decision':
      return `Проекты, которым нужно решение: ${str('titles')}.`;
    case 'strategy_suggestion':
      return `Стратегия на следующий месяц: не больше ${num('maxPriorities')} активных приоритетов, закрыть или поставить на паузу то, что не двигалось, и назначить одну оценку навыка, важного для главной цели.`;
    default:
      // An unknown code is a bug, not a reason to show machine text: the screen skips the line and
      // the test that walks real reviews fails loudly.
      return null;
  }
}

/** Parse a JSON column that holds a list of review items (or an older shape). */
export function parseReviewItems(json: string | null | undefined): ReviewItem[] {
  const parsed = parseJson(json);
  if (Array.isArray(parsed)) return parsed.filter(isItem);
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return ((parsed as { items: unknown[] }).items).filter(isItem);
  }
  return [];
}

/** True when the stored prose was written by the AI (and is therefore already in the user's language). */
export function isAiNarrative(json: string | null | undefined): boolean {
  const parsed = parseJson(json);
  return !!parsed && typeof parsed === 'object' && (parsed as { narrative?: unknown }).narrative === 'ai';
}

/** Nested objects inside a JSON column (hours, reasons, counts). */
export function parseJson<T = unknown>(json: string | null | undefined): T | null {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
}

function isItem(value: unknown): value is ReviewItem {
  return !!value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string';
}
