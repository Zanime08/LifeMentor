import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRussian, planDuration, planNoteText, planNotesText } from '@lifementor/core';

/**
 * What a day plan says, and in whose language (phase-20 i18n).
 *
 * The planner used to write English sentences straight into the plan: the Today screen showed
 * «⚠ You asked for 6h of work but the day realistically holds 3h…», every block carried «due today ·
 * serves a goal», the free block was «Free time», and the same sentences went out as OS
 * notifications — the engine composes those itself, because the OS scheduler and the push sender
 * deliver them with no interface running.
 *
 * Every sentence the planner can produce now has a code and a wording for both languages. This test
 * reads the planner's own source and fails if a code has no wording, which is what makes the pair
 * (English for the AI/export, the user's language for the person) stay in step.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const plannerSource = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'planning', 'planner.ts'), 'utf8');

function emittedCodes(): string[] {
  return [...new Set([
    ...[...plannerSource.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]),
    // warnings are pushed as items a few lines after the English sentence
    ...[...plannerSource.matchAll(/\{ code: '([a-z_]+)', params:/g)].map((m) => m[1]),
  ])].sort();
}

describe('the text of a day plan', () => {
  it('words every note the planner can emit, in both languages', () => {
    const codes = emittedCodes();
    // The guard must not pass by finding nothing: the planner emits a whole family of notes.
    expect(codes.length).toBeGreaterThanOrEqual(14);
    for (const code of codes) {
      const ru = planNoteText({ code } as never, 'ru');
      const en = planNoteText({ code } as never, 'en');
      expect(ru, `«${code}» без русской формулировки`).toBeTruthy();
      expect(en, `«${code}» без английской формулировки`).toBeTruthy();
      expect(ru).not.toContain('undefined');
      expect(ru).not.toContain('NaN');
      expect(en).not.toContain('undefined');
      // The two must actually differ — otherwise "translated" means "copied".
      expect(ru, `«${code}» не переведён`).not.toBe(en);
      expect(/[а-яё]/i.test(ru!), `«${code}» остался без кириллицы: ${ru}`).toBe(true);
    }
  });

  it('says the numbers instead of placeholders', () => {
    expect(planNoteText({ code: 'overload', params: { demanded: 360, capacity: 180, fixed: 300, deferred: 2 } }, 'ru'))
      .toBe('Вы просили 6 ч работы, но день реально вмещает 3 ч после 5 ч жёстких обязательств. 2 пункта перенесены на другой день.');
    expect(planNoteText({ code: 'overload', params: { demanded: 360, capacity: 180, fixed: 300, deferred: 1 } }, 'ru'))
      .toContain('1 пункт перенесён');
    expect(planNoteText({ code: 'overload', params: { demanded: 360, capacity: 180, fixed: 300, deferred: 5 } }, 'ru'))
      .toContain('5 пунктов перенесено');
    expect(planNoteText({ code: 'no_block', params: { minutes: 45 } }, 'ru')).toBe('не нашлось непрерывного блока на 45 мин');
    expect(planNoteText({ code: 'due_today' }, 'ru')).toBe('срок сегодня');
    expect(planNotesText([{ code: 'due_today' }, { code: 'serves_goal' }], 'ru')).toBe('срок сегодня · работает на цель');
    expect(planNotesText([], 'ru')).toBeNull();
  });

  it('keeps the plan readable for an English reader too', () => {
    expect(planNoteText({ code: 'free_time' }, 'en')).toBe('Free time');
    expect(planNoteText({ code: 'break', params: { minutes: 10 } }, 'en')).toBe('Break 10m');
    expect(planDuration(150, 'en')).toBe('2h 30m');
    expect(planDuration(150, 'ru')).toBe('2 ч 30 мин');
    expect(planDuration(120, 'ru')).toBe('2 ч');
    expect(planDuration(0, 'ru')).toBe('0 мин');
    expect(isRussian('ru-RU')).toBe(true);
    expect(isRussian('en')).toBe(false);
  });

  it('returns nothing for a code it does not know', () => {
    // A note from a newer build must not print as a code or as "undefined" on the screen.
    expect(planNoteText({ code: 'future_idea' } as never, 'ru')).toBeNull();
    expect(planNotesText([{ code: 'future_idea' } as never, { code: 'due_today' }], 'ru')).toBe('срок сегодня');
  });
});
