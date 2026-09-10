import { planNoteText, planNotesText, type DayPlan, type PlanNote, type PlannedSlot } from '@lifementor/core';

/**
 * How the plan is read (phase-20 i18n).
 *
 * The planner stores every sentence twice: the English form (`warnings`, `reason`, `note`) that the
 * AI context, the export and the logs use, and the code with the numbers behind it
 * (`warning_items`, `reason_items`, `note_items`, `generated_title`). Screens word the code.
 *
 * A plan built before this existed has only the English sentence, and hiding it would hide the fact
 * that the day is overloaded — so the fallback is the stored sentence, and it disappears with the
 * next plan build. The helpers keep that rule in one place instead of in each screen.
 */

/** The title of a block: the engine's own words in Russian, the user's own words as written. */
export function slotTitle(slot: PlannedSlot): string {
  const generated = slot.generated_title ? planNoteText(slot.generated_title, 'ru') : null;
  if (generated) return generated;
  // Legacy blocks (built before `generated_title`): the kind is still known.
  if (slot.kind === 'free') return 'Свободное время';
  if (slot.kind === 'break') return 'Перерыв';
  return slot.title;
}

/** Why this block is here. */
export function slotNote(slot: PlannedSlot): string | null {
  return planNotesText(slot.note_items, 'ru') ?? slot.note ?? null;
}

/** The plan's honest remarks about itself. */
export function planWarnings(plan: DayPlan): string[] {
  const items = (plan.warning_items ?? [])
    .map((item) => planNoteText(item, 'ru'))
    .filter((text): text is string => Boolean(text));
  return items.length ? items : (plan.warnings ?? []);
}

/** Why a task did not fit today. */
export function deferredReason(items: PlanNote[] | undefined, fallback: string): string {
  return planNotesText(items, 'ru') ?? fallback;
}
