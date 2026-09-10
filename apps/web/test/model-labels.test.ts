import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_PHRASE_RU, MODEL_LABEL_RU, modelLabelRu, modelValueRu } from '../src/lib/onboarding-ru';

/**
 * The confirmation step of onboarding shows the model the system built (req. 7). Its labels are
 * composed by the engine in English — those strings belong to the AI context, not to the screen — so
 * the interface words every item by its `key`. This test reads the engine's own list of model items
 * and demands a Russian label for each one: a new item in the engine without a label here turns this
 * test red instead of putting an English row in front of the user.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const service = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'onboarding', 'service.ts'), 'utf8');

/** `push('SKILLS', 'targets', 'Want to master', …) → the keys buildModelItems creates. */
function engineKeys(): string[] {
  const inFunction = service.slice(service.indexOf('export function buildModelItems'));
  const body = inFunction.slice(0, inFunction.indexOf('\n}'));
  return [...new Set([...body.matchAll(/push\('[A-Z_]+',\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

describe('user model labels', () => {
  it('words every item the engine can build, in Russian', () => {
    const keys = engineKeys();
    expect(keys.length).toBeGreaterThan(20);
    const missing = keys.filter((key) => !MODEL_LABEL_RU[key]);
    expect(missing, `пункты модели без русской подписи: ${missing.join(', ')}`).toEqual([]);
    for (const key of keys) {
      const label = modelLabelRu(key, 'ENGLISH FALLBACK');
      expect(label, key).not.toBe('ENGLISH FALLBACK');
      expect(/[а-яё]/i.test(label), `${key} остался не переведён: ${label}`).toBe(true);
    }
  });

  it('shows answer values in Russian, using the questionnaire as the single source of truth', () => {
    // Values come from the questionnaire, so the translation is derived from it rather than
    // duplicated: English labels never reach the screen either.
    expect(modelValueRu('Studying')).toBe('Учусь');
    expect(modelValueRu(['Studying', 'Working part-time'])).toBe('Учусь, Работаю неполный день');
    expect(modelValueRu(['structured courses', 'project-based practice'])).toBe('структурированные курсы, практика на проектах');
    expect(modelValueRu('first 3 hours after waking')).toBe('первые 3 часа после пробуждения');
    // Free text the user typed stays exactly as typed.
    expect(modelValueRu('Хочу вырасти в разработке')).toBe('Хочу вырасти в разработке');
    expect(modelValueRu(4)).toBe('4');
    expect(modelValueRu(null)).toBe('—');
  });

  it('words every phrase the engine composes itself', () => {
    // `inferLearningPreferences` invents phrases like "hands-on building" that are not questionnaire
    // options; they reach the confirmation screen as values, so each one must have a wording here.
    const body = service.slice(service.indexOf('function inferLearningPreferences'));
    // Single-word strings are answer ids (`study`, `programming`) — they are compared, never shown.
    const phrases = [...new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/'([^']+)'/g)].map((m) => m[1]))]
      .filter((phrase) => phrase.includes(' '));
    expect(phrases.length).toBeGreaterThan(4);
    const missing = phrases.filter((phrase) => !ENGINE_PHRASE_RU[phrase]);
    expect(missing, `фразы без русского текста: ${missing.join(' | ')}`).toEqual([]);
    for (const phrase of phrases) expect(modelValueRu(phrase)).not.toBe(phrase);
  });

  it('falls back to the engine label for an item it does not know', () => {
    // The fallback exists so a new engine item can never leave an empty line on the screen — the test
    // above is what makes sure the fallback is never actually needed in a release.
    expect(modelLabelRu('brand_new_key', 'Some label')).toBe('Some label');
  });
});
