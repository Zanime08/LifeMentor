/** Russian localization for the onboarding questionnaire (keys match core's question ids). */
import { QUESTIONNAIRE } from '@lifementor/core';

export const BLOCK_RU: Record<string, { title: string; subtitle: string }> = {
  situation: { title: 'Ваша ситуация', subtitle: 'Чтобы план соответствовал реальной жизни, а не воображаемой.' },
  goals: { title: 'Чего вы хотите', subtitle: 'Своими словами. Можно расплывчато — я уточню.' },
  skills: { title: 'Что вы умеете', subtitle: 'Это станет вашей стартовой картой навыков — уровни можно поправить позже.' },
  interests: { title: 'Что вас привлекает', subtitle: 'Используется для новостей, предложений обучения и связей между идеями.' },
  lifestyle: { title: 'Ваш день', subtitle: 'Планировщик строится вокруг этого, а не против него.' },
  planning: { title: 'Как вы хотите управляться', subtitle: 'Контроль остаётся у вас; здесь задаётся только тон.' },
  career_finance: { title: 'Работа и деньги', subtitle: 'Стратегия не предполагается — направление выбираете вы.' },
};

export const Q_RU: Record<string, { prompt: string; help?: string; placeholder?: string; unit?: string }> = {
  age_category: { prompt: 'Какая возрастная категория вам подходит?' },
  education: { prompt: 'Какой у вас уровень образования?' },
  main_activity: { prompt: 'Чем сейчас занято ваше время?' },
  fixed_hours_per_day: { prompt: 'Сколько часов в день уже занято обязательными делами?', help: 'Учёба, работа, дорога, уход — всё, что нельзя перенести.', unit: 'часов' },
  available_hours_per_day: { prompt: 'Сколько часов в день вы реально можете тратить на своё развитие?', help: 'Будьте честны: оптимистичная цифра даст план, от которого вы откажетесь.', unit: 'часов' },
  family_situation: { prompt: 'С кем вы живёте? (если хотите поделиться)' },
  energy_pattern: { prompt: 'Когда у вас яснее мысль?' },
  what_you_want: { prompt: 'Чего вы хотите добиться?', help: 'Что угодно: деньги, профессия, навык, здоровье, свобода, проект.', placeholder: 'напр. хочу хорошо зарабатывать и не зависеть от одного работодателя' },
  what_to_avoid: { prompt: 'Чего хотите избежать или от чего уйти?', placeholder: 'напр. выгорание, тупиковая работа, долги' },
  who_to_become: { prompt: 'Кем вы хотите стать?', placeholder: 'напр. backend-инженер, который может строить продукты один' },
  problems_to_solve: { prompt: 'Какие конкретные проблемы решить первыми?', placeholder: 'напр. нет рутины, много отвлечений, нет направления' },
  goal_horizon: { prompt: 'Когда вы хотите увидеть первый реальный результат?' },
  skills_have: { prompt: 'Что вы уже умеете?', help: 'Через запятую. Включите то, что умеете «так себе».', placeholder: 'напр. английский B2, базовый Python, вождение, готовка' },
  skills_learning: { prompt: 'Чему учитесь сейчас?', placeholder: 'напр. Python, гитара' },
  skills_want: { prompt: 'Что хотите освоить?', placeholder: 'напр. backend-разработка, инвестиции, публичные выступления' },
  proof_of_skill: { prompt: 'Что вы реально построили, выпустили или сдали?', help: 'Реальные доказательства задают уровень точнее самооценки.', placeholder: 'напр. телеграм-бот, сертификат курса, 2 года в продажах' },
  interests: { prompt: 'Какие области вас интересуют?' },
  interests_other: { prompt: 'Что-то ещё, что стоит знать?' },
  curiosity: { prompt: 'О чём вы могли бы читать или говорить часами?' },
  wake_time: { prompt: 'Во сколько вы обычно вставаете?' },
  sleep_time: { prompt: 'Во сколько обычно ложитесь?' },
  typical_day: { prompt: 'Опишите типичный день, примерно.', placeholder: 'напр. 8-15 колледж, 16-18 спортзал, вечером свобода' },
  distractions: { prompt: 'Что обычно забирает ваше время?' },
  obligations: { prompt: 'Что регулярно ломает ваши планы?', help: 'Смены, здоровье, обязанности перед семьёй, экзамены.' },
  planning_style: { prompt: 'Насколько строгим должен быть план?' },
  strictness: { prompt: 'Насколько настойчиво наставник должен подталкивать?' },
  free_time_desired: { prompt: 'Сколько свободного времени в день вы хотите беречь?', unit: 'часов', placeholder: 'напр. 1.5' },
  reminder_attitude: { prompt: 'Что вы думаете о напоминаниях?' },
  planning_history: { prompt: 'Что не срабатывало в прошлых попытках?', help: 'Знание этого мешает повторять ошибки.' },
  career_direction: { prompt: 'Какие из этих направлений вам реально нужны?' },
  financial_situation: { prompt: 'Как бы вы описали свои финансы сейчас?' },
  risk_tolerance: { prompt: 'Сколько риска вы готовы брать?' },
  capital_available: { prompt: 'Сколько денег можно вложить (если вообще)?', unit: 'в вашей валюте' },
  income_expectation: { prompt: 'Что конкретно для вас означает «хорошо зарабатывать»?', help: 'Цифра, образ жизни или свобода от чего-то.' },
};

export const OPT_RU: Record<string, string> = {
  under_18: 'Младше 18', '18_24': '18–24', '25_34': '25–34', '35_44': '35–44', '45_54': '45–54', '55_plus': '55+',
  prefer_not_to_say: 'Лучше не говорить',
  school: 'Школа', secondary: 'Среднее', vocational: 'Колледж / техникум', bachelor: 'Бакалавриат', master: 'Магистратура', phd: 'Доктор', self_taught: 'В основном самоучка', other: 'Другое',
  study: 'Учусь', work_full_time: 'Работаю полностью', work_part_time: 'Работаю неполный день', freelance: 'Фриланс', job_search: 'Ищу работу', caregiving: 'Ухаживаю за семьёй', military: 'Армейская служба',
  alone: 'Один(а)', partner: 'С партнёром', children: 'С детьми', parents: 'С родителями / семьёй', shared: 'Общая квартира',
  morning: 'Утро', afternoon: 'День', evening: 'Вечер', night: 'Поздно ночью', variable: 'Меняется',
  '1mo': 'В течение месяца', '3mo': 'В течение 3 месяцев', '1y': 'В течение года', '3y': 'Через 2–5 лет', unclear: 'Пока неясно',
  technology: 'Технологии', programming: 'Программирование', ai: 'ИИ', science: 'Наука', finance: 'Финансы и инвестиции', sport: 'Спорт и физкультура', creativity: 'Творчество и искусство', music: 'Музыка', languages: 'Языки', history: 'История', philosophy: 'Философия', health: 'Здоровье', games: 'Игры', travel: 'Путешествия',
  social_media: 'Соцсети', short_videos: 'Короткие видео', phone: 'Телефон / мессенджеры', tv: 'ТВ / стриминг', people: 'Люди вокруг', noise: 'Шум / нет места', poor_sleep: 'Плохой сон', overthinking: 'Излишние мысли',
  strict: 'Строго', balanced: 'Сбалансированно', flexible: 'Гибко',
  none_reminder: 'Минимум', gentle: 'Мягко', firm: 'Настойчиво',
  stable_career: 'Стабильная карьера', high_income: 'Высокий доход', own_business: 'Свой бизнес', investments: 'Инвестирование', multiple_incomes: 'Несколько источников дохода', financial_independence: 'Финансовая независимость', creative_career: 'Творческая карьера', academia: 'Наука / академия', public_service: 'Госслужба', undecided: 'Ещё не решил(а)',
  tight: 'Тяжело', stable: 'Стабильно', comfortable: 'Комфортно',
};

/** Option ids that collide between questions get a per-question override. */
const OPT_RU_OVERRIDES: Record<string, Record<string, string>> = {
  main_activity: { none: 'Пока ничего постоянного', business: 'Веду бизнес' },
  reminder_attitude: { none: 'Минимум' },
  interests: { other: 'Другое', business: 'Бизнес' },
  career_direction: { other: 'Другое' },
  distractions: { other: 'Другое' },
  planning_style: { flexible: 'Гибко' },
};

export function optRu(questionKey: string, id: string, fallback: string): string {
  return OPT_RU_OVERRIDES[questionKey]?.[id] ?? OPT_RU[id] ?? fallback;
}

export const GAP_TYPE_RU: Record<string, string> = {
  missing_data: 'не хватает данных', contradiction: 'противоречие', vague_goal: 'расплывчатая цель',
  goal_conflict: 'конфликт целей', skill_ambiguity: 'неясный навык', unknown_constraint: 'неизвестное ограничение', missing_horizon: 'нет горизонта',
};

export const SECTION_RU: Record<string, string> = {
  PROFILE: 'Профиль', VALUES: 'Ценности', GOALS: 'Цели', CONSTRAINTS: 'Ограничения', INTERESTS: 'Интересы',
  SKILLS: 'Навыки', KNOWLEDGE: 'Знания', PROJECTS: 'Проекты', PREFERENCES: 'Предпочтения', TIME_AVAILABILITY: 'Время',
  MOTIVATION_FACTORS: 'Мотивация', DISTRACTIONS: 'Отвлечения', LEARNING_PREFERENCES: 'Стиль обучения',
  CAREER_DIRECTION: 'Карьерное направление', FINANCIAL_DIRECTION: 'Финансовое направление', OTHER: 'Прочее',
};

/**
 * Подписи пунктов модели («Вот как я вас понял»). Движок строит их по-английски — это внутренние
 * строки, которые читают AI-контекст и экспорт; человеку их показывает интерфейс, на его языке.
 * Ключ — `key` пункта модели (он уникален), поэтому английская подпись движка никогда не попадает
 * на экран. `modelLabelRu` вызывается для каждого пункта, а тест `model-labels.test.ts` сверяет
 * карту со списком ключей, которые движок действительно умеет создавать.
 */
export const MODEL_LABEL_RU: Record<string, string> = {
  age_category: 'Возраст',
  education: 'Образование',
  main_activity: 'Чем занимаетесь',
  family_situation: 'С кем живёте',
  energy_pattern: 'Когда голова работает лучше',
  primary: 'Чего вы хотите достичь',
  avoid: 'Чего хотите избежать',
  identity: 'Кем хотите стать',
  problems: 'Что решить в первую очередь',
  horizon: 'Ожидаемый первый результат',
  current: 'Уже есть навыки',
  learning: 'Сейчас учусь',
  targets: 'Хочу освоить',
  evidence: 'Реальные доказательства навыка',
  areas: 'Интересы',
  other: 'Другие интересы',
  curiosity: 'О чём можете говорить часами',
  wake_time: 'Обычно встаю',
  sleep_time: 'Обычно ложусь',
  typical_day: 'Типичный день',
  obligations: 'Что ломает планы',
  main: 'Главные отвлечения',
  planning_style: 'Стиль планирования',
  strictness: 'Насколько жёстко подгонять',
  free_time_desired_hours: 'Свободное время (ч/день)',
  reminder_attitude: 'Отношение к напоминаниям',
  past_failures: 'Что не получилось раньше',
  wants: 'Карьерное направление',
  situation: 'Финансовая ситуация',
  risk_tolerance: 'Склонность к риску (1–5)',
  capital_available: 'Доступный капитал',
  level: 'Уровень',
  available_hours_per_day: 'Часов в день на развитие',
  fixed_hours_per_day: 'Занятых часов в день',
  disruptions: 'Что ломает планы',
  definition_of_earning_well: 'Что значит «зарабатывать хорошо»',
  realistic_daily_focus_minutes: 'Реалистичный фокус в день (мин)',
  best_focus_window: 'Лучшее окно для фокуса',
  formats: 'Подходящие форматы обучения',
};

export function modelLabelRu(key: string, fallback: string): string {
  return MODEL_LABEL_RU[key] ?? fallback;
}

/**
 * Обратный перевод: английская подпись варианта → русская. Обе таблицы (label→id→русский) строятся
 * из самого опросника, поэтому третьего списка перевода не существует: то же соответствие, что и в
 * вопросах. Нужен там, где движок уже подставил подпись («Модель пользователя», шаг подтверждения) —
 * значение пришло из вопроса, но интерфейс должен показать его по-русски.
 */
const LABEL_RU = (() => {
  const map = new Map<string, string>();
  for (const block of QUESTIONNAIRE) {
    for (const question of block.questions) {
      for (const option of question.options ?? []) {
        if (!map.has(option.label)) map.set(option.label, optRu(question.key, option.id, option.label));
      }
    }
  }
  return map;
})();

/**
 * Фразы, которые движок составляет сам (не из вариантов ответа). Их немного, и они не переводятся
 * автоматически — список проверяется тестом `model-labels.test.ts`, чтобы ни одна новая фраза
 * движка не появилась на экране по-английски.
 */
export const ENGINE_PHRASE_RU: Record<string, string> = {
  'first 3 hours after waking': 'первые 3 часа после пробуждения',
  'late evening': 'поздний вечер',
  'afternoon/evening': 'день и вечер',
  'structured courses': 'структурированные курсы',
  'project-based practice': 'практика на проектах',
  'hands-on building': 'делать руками',
  'documentation reading': 'чтение документации',
  'daily short practice': 'короткая практика каждый день',
  'speaking practice': 'разговорная практика',
  'short daily sessions': 'короткие ежедневные занятия',
  'micro-sessions (15-25 min)': 'микроссессии 15–25 минут',
  'early morning (before work)': 'раннее утро, до работы',
  'evening after work': 'вечер после работы',
  'weekend blocks': 'блоки на выходных',
};

/** Значение пункта модели по-русски: подписи вариантов и фразы движка, свободный текст — как есть. */
export function modelValueRu(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => modelValueRu(v)).join(', ');
  if (typeof value !== 'string') return String(value ?? '—');
  const trimmed = value.trim();
  return LABEL_RU.get(trimmed) ?? ENGINE_PHRASE_RU[trimmed] ?? value;
}
