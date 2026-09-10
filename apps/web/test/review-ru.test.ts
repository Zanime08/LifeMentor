import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAiNarrative, parseReviewItems, reviewItemText } from '../src/lib/review-ru';

/**
 * The wording of reviews (req. 77, 78).
 *
 * The engine decides what a review says and stores every sentence as a code plus the numbers behind
 * it; the Russian wording lives in the client. That split only works while the two stay in sync, so
 * this test reads the engine's source and demands a wording for **every** code it can emit. Adding a
 * sentence to the engine without wording it for the user turns this test red instead of shipping a
 * screen with a `{"code":"..."}` blob on it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const engineSource = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'services', 'progress.ts'), 'utf8');

function emittedCodes(): string[] {
  return [...new Set([...engineSource.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

describe('review wording', () => {
  it('words every sentence the engine can emit, in Russian', () => {
    const codes = emittedCodes();
    // The engine must actually be emitting review items — an empty list would make this test pass
    // by doing nothing at all.
    expect(codes.length).toBeGreaterThan(15);
    const missing = codes.filter((code) => !reviewItemText({ code }));
    expect(missing, `коды без русской формулировки: ${missing.join(', ')}`).toEqual([]);
    for (const code of codes) {
      const text = reviewItemText({ code })!;
      expect(text, code).not.toContain('undefined');
      expect(text, code).not.toContain('NaN');
      expect(/[а-яё]/i.test(text), `«${code}» остался не переведён: ${text}`).toBe(true);
    }
  });

  it('fills in the numbers instead of showing placeholders', () => {
    expect(reviewItemText({ code: 'tasks_completed', params: { count: 3, focusMinutes: 90 } })).toBe('Сделано задач: 3 · 1 ч 30 мин в фокусе');
    expect(reviewItemText({ code: 'postponed', params: { count: 2 } })).toBe('Перенесено задач: 2');
    expect(reviewItemText({ code: 'best_hours', params: { best: 10, bestRate: 80, worst: 22, worstRate: 25 } }))
      .toBe('Работа около 10:00 удаётся в 80% случаев, около 22:00 — только в 25%.');
    expect(reviewItemText({ code: 'untouched_goals', params: { count: 1, titles: 'Английский' } }))
      .toBe('Целей без движения: 1 — Английский.');
    expect(reviewItemText({ code: 'untouched_goals', params: { count: 2 } })).toBe('Целей без движения: 2');
    expect(reviewItemText({ code: 'strategy_suggestion', params: { maxPriorities: 3 } })).toContain('не больше 3 активных приоритетов');
  });

  it('skips a code it does not know instead of printing machine text', () => {
    expect(reviewItemText({ code: 'some_future_idea', params: { x: 1 } })).toBeNull();
  });

  it('reads the item list from every shape the reviews have been stored in', () => {
    const items = [{ code: 'postponed', params: { count: 1 } }];
    // monthly reviews store { items, strategy, narrative } …
    expect(parseReviewItems(JSON.stringify({ items, strategy: [], narrative: 'engine' }))).toEqual(items);
    // … and a plain array is accepted as well
    expect(parseReviewItems(JSON.stringify(items))).toEqual(items);
    // a pre-items review (an array of English sentences) yields nothing rather than a broken list
    expect(parseReviewItems(JSON.stringify(['2 tasks postponed.']))).toEqual([]);
    expect(parseReviewItems('not json')).toEqual([]);
    expect(parseReviewItems(null)).toEqual([]);
  });

  it('tells the AI-written narrative apart from the engine fallback', () => {
    expect(isAiNarrative(JSON.stringify({ narrative: 'ai' }))).toBe(true);
    expect(isAiNarrative(JSON.stringify({ narrative: 'engine' }))).toBe(false);
    expect(isAiNarrative(JSON.stringify(['2 tasks postponed.']))).toBe(false);
    expect(isAiNarrative(null)).toBe(false);
  });
});
