import type { ReviewItem, StrategyHorizon } from '@lifementor/core';

/** Horizon names, shared by the ladder and by the audit wording below. */
export const HORIZON_LABEL: Record<string, string> = {
  '3-5y': '3–5 лет',
  '1y': 'Год',
  '3mo': '3 месяца',
  '1mo': 'Месяц',
  '1w': 'Неделя',
  today: 'Сегодня',
  now: 'Сейчас',
};

export function horizonLabel(horizon: StrategyHorizon | string): string {
  return HORIZON_LABEL[horizon] ?? String(horizon);
}

/**
 * Wording for the strategy connectivity audit (req. 45).
 *
 * `strategy.audit()` says what is missing in the ladder — an empty horizon, items not linked to a
 * goal, a level with nothing above it. Those sentences are English in the engine (the AI context and
 * the export read them); the screen words them for the user, from the code and the numbers in it.
 */
export function auditWarningText(item: ReviewItem): string | null {
  const p = (item.params ?? {}) as Record<string, string | number>;
  const horizon = horizonLabel(String(p.horizon));
  switch (item.code) {
    case 'no_direction':
      return `На горизонте «${horizon}» пока нет ни одного направления.`;
    case 'none_linked':
      return `Ни одно из ${Number(p.count) || 0} направлений здесь не связано с целью — такие пункты не прослеживаются до сегодняшних действий.`;
    case 'no_parent':
      return `У горизонта «${horizon}» нет направления выше (${horizonLabel(String(p.parent))}) — свяжите его с более дальней целью.`;
    default:
      // An unknown code means the engine learned to say something new: nothing is shown (never the
      // raw English) and the test that reads the engine's source fails.
      return null;
  }
}
