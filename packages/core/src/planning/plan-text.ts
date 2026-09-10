/**
 * What a day plan says to the user, and in whose language (phase-20 i18n).
 *
 * The planner decided *what* to say months ago, but it said it in English: the Today screen showed
 * «⚠ You asked for 6h of work but the day realistically holds 3h…», every task block carried a note
 * like «due today · serves a goal», the free block was titled «Free time», and the deferred list
 * explained itself with «less than 10 minutes of capacity left». The same English sentences went out
 * as OS notifications, because the engine composes the text that the platform and the push sender
 * deliver with no interface running.
 *
 * So the plan carries both forms: the English sentence (stable for the AI context, JSON export and
 * logs) and a `PlanNote` — a code plus the numbers behind it. Screens word the code in Russian, and
 * the engine uses the same function for notification text, which is why the wording lives in the
 * core rather than in the client (reviews are client-worded precisely because only a screen ever
 * renders them).
 *
 * Unknown code → `null`; callers fall back to the stored English sentence, which is the best
 * available answer for a plan written by an older build.
 */
export interface PlanNote {
  code: PlanNoteCode;
  params?: Record<string, number | string>;
}

export type PlanNoteCode =
  // ── slots ──────────────────────────────────────────────────────────────
  | 'free_time'            // { minutes }
  | 'free_time_note'
  | 'break'                // { minutes }
  | 'spaced_repetition'    // { due, limit }
  | 'active_recall'
  | 'fixed_commitment'
  // ── why this task is here (slot notes) ─────────────────────────────────
  | 'overdue_by'           // { days }
  | 'due_today'
  | 'due_in'               // { days }
  | 'marked_important'
  | 'postponed_n'          // { count }
  | 'serves_goal'
  // ── deferred ───────────────────────────────────────────────────────────
  | 'day_full'
  | 'no_room'              // less than ten minutes left
  | 'no_block'             // { minutes }
  // ── warnings ───────────────────────────────────────────────────────────
  | 'overload'             // { demanded, capacity, fixed, deferred } (minutes, minutes, minutes, count)
  | 'fixed_heavy'
  | 'no_free_time'
  | 'observed_load';       // { observed } (minutes)

/** True when the reader's language is Russian (anything starting with `ru`). */
export function isRussian(language?: string | null): boolean {
  return (language ?? 'en').toLowerCase().startsWith('ru');
}

/**
 * "2 ч 30 мин" / "2h 30m" — the plan speaks in minutes, the user reads hours.
 * Exported because the notification composer needs the same numbers in the same language.
 */
export function planDuration(minutes: number, language?: string | null): string {
  return duration(minutes, isRussian(language));
}

/** "2 ч 30 мин" / "2h 30m" — the plan speaks in minutes, the user reads hours. */
function duration(minutes: number, ru: boolean): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (ru) {
    if (!hours) return `${rest} мин`;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Plural form for a Russian count: 1 задача, 2 задачи, 5 задач. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** The sentence for one plan note, in the language the reader uses. `null` for an unknown code. */
export function planNoteText(note: PlanNote, language?: string | null): string | null {
  const ru = (language ?? 'en').toLowerCase().startsWith('ru');
  const p = note.params ?? {};
  const num = (key: string, fallback = 0): number => {
    const value = p[key];
    return typeof value === 'number' ? value : Number(value ?? fallback) || fallback;
  };
  switch (note.code) {
    case 'free_time':
      return ru ? 'Свободное время' : 'Free time';
    case 'free_time_note':
      return ru ? 'защищено — это не дырка, которую надо занять' : 'protected — not a gap to fill';
    case 'break':
      return ru ? `Перерыв ${duration(num('minutes', 10), true)}` : `Break ${duration(num('minutes', 10), false)}`;
    case 'spaced_repetition':
      return ru
        ? `Повторение (${num('due')} карточек, максимум ${num('limit')})`
        : `Spaced repetition (${num('due')} cards due, up to ${num('limit')})`;
    case 'active_recall':
      return ru ? 'активное вспоминание · намеренно коротко' : 'active recall · short by design';
    case 'fixed_commitment':
      return ru ? 'жёсткое обязательство — план не ставится поверх него' : 'fixed commitment — nothing is scheduled over this';
    case 'overdue_by':
      return ru ? `просрочено на ${num('days')} дн.` : `overdue by ${num('days')}d`;
    case 'due_today':
      return ru ? 'срок сегодня' : 'due today';
    case 'due_in':
      return ru ? `срок через ${num('days')} дн.` : `due in ${num('days')}d`;
    case 'marked_important':
      return ru ? 'отмечено важным' : 'marked important';
    case 'postponed_n':
      return ru ? `переносилось ${num('count')} раз` : `postponed ${num('count')}×`;
    case 'serves_goal':
      return ru ? 'работает на цель' : 'serves a goal';
    case 'day_full':
      return ru
        ? 'день забит — план ограничен тем, что день физически вмещает'
        : 'today is full — the plan is capped by what the day physically holds';
    case 'no_room':
      return ru ? 'осталось меньше 10 минут ресурса' : 'less than 10 minutes of capacity left';
    case 'no_block':
      return ru
        ? `не нашлось непрерывного блока на ${duration(num('minutes'), true)}`
        : `no continuous ${num('minutes')}-minute block left (day is full)`;
    case 'overload':
      return ru
        ? `Вы просили ${duration(num('demanded'), true)} работы, но день реально вмещает ${duration(num('capacity'), true)} `
          + `после ${duration(num('fixed'), true)} жёстких обязательств. ${num('deferred')} `
          + `${pluralRu(num('deferred'), 'пункт перенесён', 'пункта перенесены', 'пунктов перенесено')} на другой день.`
        : `You asked for ${duration(num('demanded'), false)} of work but the day realistically holds `
          + `${duration(num('capacity'), false)} after ${duration(num('fixed'), false)} of fixed commitments. `
          + `${num('deferred')} item(s) moved off today.`;
    case 'fixed_heavy':
      return ru
        ? 'День почти целиком занят обязательствами. План намеренно минимальный.'
        : 'This day is mostly fixed commitments. I kept the plan minimal on purpose.';
    case 'no_free_time':
      return ru
        ? 'Свободного времени, которое вы защитили, сегодня не осталось — подумайте, что сдвинуть.'
        : 'No room for protected free time today — consider moving something.';
    case 'observed_load':
      return ru
        ? `По последним неделям вы закрываете около ${duration(num('observed'), true)} сфокусированной работы в день — план держится рядом с этим.`
        : `Based on the last weeks you complete ~${duration(num('observed'), false)} of focused work a day; the plan stays near that.`;
    default:
      return null;
  }
}

/** One line out of several notes: «срок сегодня · работает на цель». */
export function planNotesText(notes: PlanNote[] | undefined, language?: string | null, separator = ' · '): string | null {
  if (!notes?.length) return null;
  const parts = notes.map((note) => planNoteText(note, language)).filter((text): text is string => Boolean(text));
  return parts.length ? parts.join(separator) : null;
}
