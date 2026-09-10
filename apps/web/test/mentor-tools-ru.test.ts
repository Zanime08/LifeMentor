// @vitest-environment jsdom
/**
 * Every tool the assistant can call is named in the chat in the user's language (phase-20 i18n).
 *
 * The chat shows what actually happened as chips — «построил план дня», «создал задачу». Those
 * labels live in `Mentor.tsx` next to the screen that renders them, which means they drift silently:
 * a tool added to the registry simply appeared as `create_project` to a Russian reader, and nothing
 * failed. This reads the real registry out of `packages/core/src/ai/tools.ts` and the real labels out
 * of the screen, so the drift is a failing test instead of a puzzle in the interface.
 *
 * It also covers the questions asked before a dangerous action: the registry writes them for the
 * model, in English (`Cancel the task "…"? It will be removed from planning.`), and `confirm-ru.ts`
 * turns each one into the sentence the person reads. A tool with a `confirm` policy and no wording
 * would ask for approval of something irreversible in a language the user may not read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConfirmationRequest } from '@lifementor/core';
import { confirmationText } from '../src/lib/confirm-ru';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const registrySource = readFileSync(join(root, 'packages/core/src/ai/tools.ts'), 'utf8');
const mentorSource = readFileSync(join(root, 'apps/web/src/screens/Mentor.tsx'), 'utf8');

/** Tool names as the registry declares them. */
function registryTools(): string[] {
  return [...registrySource.matchAll(/\bname: '([a-z][a-z0-9_]+)'/g)].map((m) => m[1]);
}

/** Tools whose execution can be refused until the user approves that exact call. */
function confirmTools(): string[] {
  return registrySource
    .split(/registry\.register\(\{/)
    .slice(1)
    .filter((block) => /confirm:/.test(block))
    .map((block) => /\bname: '([a-z][a-z0-9_]+)'/.exec(block)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** The `TOOL_RU` object literal, keyed by tool name. */
function toolLabels(): Record<string, string> {
  const block = /const TOOL_RU: Record<string, string> = \{([\s\S]*?)\n\};/.exec(mentorSource);
  expect(block, 'TOOL_RU must exist in Mentor.tsx').toBeTruthy();
  const labels: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const match = /^\s*'?([a-z][a-z0-9_]*)'?:\s*'([^']*)'/.exec(line);
    if (match) labels[match[1]] = match[2];
  }
  return labels;
}

const cyrillic = /[а-яё]/i;

describe('the mentor names every tool in Russian', () => {
  it('reads the registry, so the check cannot pass on an empty list', () => {
    expect(registryTools().length).toBeGreaterThanOrEqual(25);
    expect(confirmTools().length).toBeGreaterThanOrEqual(8);
  });

  it('has a Russian label for every tool the assistant can call', () => {
    const labels = toolLabels();
    const missing = registryTools().filter((name) => !labels[name]);
    expect(missing, `tools without a Russian label: ${missing.join(', ')}`).toEqual([]);
    const notRussian = Object.entries(labels).filter(([, label]) => !cyrillic.test(label));
    expect(notRussian.map(([name]) => name)).toEqual([]);
    // The user must never see the raw name in the chat.
    const raw = Object.entries(labels).filter(([name, label]) => label.includes(name));
    expect(raw.map(([name]) => name)).toEqual([]);
  });

  it('keeps the legacy label the old profile tool used', () => {
    // Created before the registry rename; a conversation restored from a backup still shows it.
    expect(toolLabels().get_user_profile).toBeTruthy();
  });

  it('asks a readable question before every action that needs approval', () => {
    const asks = (name: string): string => confirmationText({
      id: `${name}:x`, title: name, detail: '', tool: name, risk: 'destructive', args: {},
    } as unknown as ConfirmationRequest);

    for (const name of confirmTools()) {
      const question = asks(name);
      expect(question, `${name} must be worded in Russian`).toMatch(cyrillic);
      expect(question, `${name} must not fall back to the raw tool name`).not.toMatch(/^Выполнить действие «.+»\? Проверьте/);
      // A trailing explanation («Она уйдёт из плана.») is welcome; a missing question is not.
      expect(question, `${name} must ask something: ${question}`).toContain('?');
    }
  });

  it('names the arguments the user recognises, never a raw id', () => {
    const uuid = '3f7c1a52-9b0e-4a11-8f2d-77c1f0a2b6d4';
    expect(confirmationText({ id: 'x', title: '', detail: '', tool: 'cancel_task', risk: 'destructive', args: { task: uuid } } as unknown as ConfirmationRequest))
      .not.toContain(uuid);
    expect(confirmationText({ id: 'x', title: '', detail: '', tool: 'cancel_task', risk: 'destructive', args: { task: 'Отменить поездку' } } as unknown as ConfirmationRequest))
      .toContain('«Отменить поездку»');
  });

  it('gives an unknown tool a safe, readable question instead of English', () => {
    // A conversation restored from a newer build: the label is unknown, the question still stands.
    const question = confirmationText({
      id: 'x', title: 'Do the dangerous thing', detail: 'Continue?', tool: 'do_dangerous_thing',
      risk: 'destructive', args: {},
    } as unknown as ConfirmationRequest, 'сделал что-то важное');
    expect(question).toContain('сделал что-то важное');
    expect(question).toMatch(cyrillic);
  });
});
