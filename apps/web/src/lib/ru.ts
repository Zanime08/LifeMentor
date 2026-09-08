/** Small formatting helpers for the Russian UI. */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DOW_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function fmtDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1].slice(0, 3)}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDayDow(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return `${DOW_FULL[dt.getDay()]}, ${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** "YYYY-MM-DDTHH:MM:SS" (local) → "HH:MM" */
export function hm(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.length >= 16 ? iso.slice(11, 16) : iso;
}

export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} дн назад`;
  return fmtDay(dayOf(iso));
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtMinutes(min: number): string {
  if (!min) return '—';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

export const HORizons_RU: Record<string, string> = {
  long: 'Долгосрочная (годы)',
  medium: 'Среднесрочная (месяцы)',
  short: 'Краткосрочная (недели)',
  daily: 'Ежедневная',
};

export const STATUS_RU: Record<string, string> = {
  active: 'Активна', paused: 'Пауза', achieved: 'Достигнута', abandoned: 'Отказ', archived: 'Архив',
  todo: 'К выполнению', scheduled: 'Запланирована', in_progress: 'Выполняется', done: 'Готово', cancelled: 'Отменена', postponed: 'Перенесена',
  idea: 'Идея', done_p: 'Завершён',
  pending: 'Ожидает', asked: 'Задан', answered: 'Отвечен', skipped: 'Пропущен',
  confirmed: 'Подтверждено', inferred: 'Предположение', uncertain: 'Неопределённо',
};

export const KIND_RU: Record<string, string> = {
  generic: 'Обычная', learning: 'Обучение', practice: 'Практика', review: 'Повторение', project: 'Проект', health: 'Здоровье', errand: 'Бытовое', work: 'Работа',
  class: 'Учёба', meeting: 'Встреча', commute: 'Дорога', training: 'Тренировка', social: 'Общение', exam: 'Экзамен', free: 'Свободное время',
  fact: 'Факт', preference: 'Предпочтение', goal_change: 'Смена цели', decision: 'Решение', event: 'Событие', insight: 'Вывод', behavior: 'Поведение', skill_evidence: 'Подтверждение навыка',
  user_provided: 'От пользователя', ai_inferred: 'Определено ИИ', system_observed: 'Наблюдение системы', unknown: 'Неизвестно',
  world: 'Мир', technology: 'Технологии', ai: 'ИИ', economy: 'Экономика', business: 'Бизнес', science: 'Наука', geopolitics: 'Геополитика', programming: 'Программирование',
  urgent: 'Срочно', digest: 'Дайджест', none: '—',
  daily_plan: 'План дня', schedule_start: 'Начало события', task_reminder: 'Напоминание о задаче', learning_review: 'Повторение', important_news: 'Важные новости', goal_review: 'Проверка цели', project_deadline: 'Дедлайн проекта', mentor_message: 'Сообщение наставника', daily_digest: 'Дайджест дня',
};

export const PRIORITY_RU: Record<string, string> = { P0: 'P0 · критично', P1: 'P1 · высокий', P2: 'P2 · средний', P3: 'P3 · низкий' };
export const ENERGY_RU: Record<string, string> = { low: 'лёгкая', medium: 'средняя', high: 'нагрузочная' };
export const REASON_RU: Record<string, string> = {
  unexpected_event: 'Непредвиденное событие', lack_of_time: 'Не хватает времени', fatigue: 'Усталость',
  illness: 'Болезнь', procrastination: 'Прокрастинация', other: 'Другое',
};
export const SKIP_REASONS = ['unexpected_event', 'lack_of_time', 'fatigue', 'illness', 'procrastination', 'other'] as const;
