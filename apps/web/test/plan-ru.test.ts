/**
 * The plan as the user reads it (phase-20 i18n).
 *
 * The planner stores every sentence twice: English for the AI context and the export, and a code
 * with the numbers behind it for the person. These are the client-side rules that turn the second
 * form into words — including what happens to a plan that was built before the codes existed.
 */
import { describe, expect, it } from 'vitest';
import type { DayPlan, PlannedSlot } from '@lifementor/core';
import { deferredReason, planWarnings, slotNote, slotTitle } from '../src/lib/plan';

const slot = (over: Partial<PlannedSlot>): PlannedSlot => ({ start: '09:00', end: '10:00', kind: 'task', title: 'x', ...over });

describe('the plan on screen', () => {
  it('names the engine\'s own blocks in Russian, and the user\'s blocks as written', () => {
    expect(slotTitle(slot({ kind: 'free', title: 'Free time', generated_title: { code: 'free_time' } }))).toBe('Свободное время');
    expect(slotTitle(slot({ kind: 'break', title: 'Break', generated_title: { code: 'break', params: { minutes: 10 } } }))).toBe('Перерыв 10 мин');
    expect(slotTitle(slot({ title: 'Spaced repetition (3 cards due)', generated_title: { code: 'spaced_repetition', params: { due: 3, limit: 20 } } })))
      .toBe('Повторение (3 карточек, максимум 20)');
    // A task is the user's own words — never translated, never replaced.
    expect(slotTitle(slot({ title: 'Дочитать главу 4', taskId: 't1' }))).toBe('Дочитать главу 4');
  });

  it('falls back to the engine title for a block built before the codes existed', () => {
    // Old plans (and old exports) have no `generated_title`; the kind is still known, so the free
    // and break blocks are still readable.
    expect(slotTitle(slot({ kind: 'free', title: 'Free time' }))).toBe('Свободное время');
    expect(slotTitle(slot({ kind: 'break', title: 'Break' }))).toBe('Перерыв');
    expect(slotTitle(slot({ title: 'Spaced repetition (3 cards due)' }))).toBe('Spaced repetition (3 cards due)');
  });

  it('explains why a block is there', () => {
    expect(slotNote(slot({ note: 'due today · serves a goal', note_items: [{ code: 'due_today' }, { code: 'serves_goal' }] })))
      .toBe('срок сегодня · работает на цель');
    expect(slotNote(slot({ note: 'due today' }))).toBe('due today'); // legacy plan: better than nothing
    expect(slotNote(slot({}))).toBeNull();
  });

  it('keeps the day\'s warnings and the deferred reasons readable', () => {
    const plan = {
      warning_items: [{ code: 'overload', params: { demanded: 360, capacity: 120, fixed: 300, deferred: 2 } }],
      warnings: ['You asked for 6h of work but the day realistically holds 2h after 5h of fixed commitments. 2 item(s) moved off today.'],
    } as unknown as DayPlan;
    expect(planWarnings(plan)[0]).toContain('Вы просили 6 ч работы');
    expect(planWarnings(plan)).toHaveLength(1);
    // A plan from an older build: the stored sentence is all there is, and it is not hidden.
    expect(planWarnings({ warnings: ['This day is mostly fixed commitments.'] } as unknown as DayPlan))
      .toEqual(['This day is mostly fixed commitments.']);
    expect(planWarnings({ warnings: [] } as unknown as DayPlan)).toEqual([]);
    expect(deferredReason([{ code: 'no_room' }], 'less than 10 minutes of capacity left')).toBe('осталось меньше 10 минут ресурса');
    expect(deferredReason(undefined, 'today is full')).toBe('today is full');
  });

  it('never prints a code or an empty string for a note it does not know', () => {
    const plan = { warning_items: [{ code: 'future_warning' }, { code: 'no_free_time' }], warnings: ['English fallback'] } as unknown as DayPlan;
    expect(planWarnings(plan)).toEqual(['Свободного времени, которое вы защитили, сегодня не осталось — подумайте, что сдвинуть.']);
    expect(slotTitle(slot({ kind: 'free', title: 'Free time', generated_title: { code: 'future_block' } as never }))).toBe('Свободное время');
  });
});
