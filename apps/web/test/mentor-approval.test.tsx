// @vitest-environment jsdom
/**
 * Approving a dangerous action in the chat (phase-20 hardening, req. 22–24).
 *
 * The engine refuses to delete an event, cancel a task, archive a goal or raise a task to P0 without
 * the user's approval of that exact call. It hands the model a question; nothing in the interface
 * ever showed it or answered it, so those tools could never run — the user said «да, удали» and got
 * the same refusal back, forever. This drives the real screen, the real registry and the real SQLite:
 * the only stand-in is the model's answer (`mentor.chat`), which is what a test may mock.
 */
import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TurnResult } from '@lifementor/core';
import { needsInputItemText } from '@lifementor/core';

vi.mock('../src/core/app', async () => await import('./support/app-harness'));

import App from '../src/App';
import { bootstrapApp, disposeHarness, openApp } from './support/app-harness';

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
});

afterAll(async () => {
  await disposeHarness();
});

/**
 * Render the mentor screen on an app that has already been through onboarding (this file is about
 * the approval card, not about the first-run interview — `ui-journey.test.tsx` drives that through
 * the DOM). The gate, the router and the screens are the real ones.
 */
async function openMentor(): Promise<NonNullable<ReturnType<typeof openApp>>> {
  const app = await bootstrapApp();
  const flags = await app.services.settings.get('flags');
  if (!flags.onboarding_completed) {
    await app.services.onboarding.start();
    await app.services.onboarding.complete();
  }
  window.location.hash = '#/mentor';
  render(<App />);
  await waitFor(() => {
    expect(openApp()).not.toBeNull();
  }, { timeout: 30_000 });
  return openApp()!;
}

describe('the mentor asks before a destructive action', () => {
  it('shows the question in Russian and does the action only after «Разрешить»', async () => {
    const app = await openMentor();

    const task = await app.services.tasks.create({ title: 'Отменить поездку в Москву', estimated_minutes: 15 });
    // What the model proposes: the real registry produces the confirmation request (nothing is
    // faked about the engine's policy — only the model's reply is). The model names the task the way
    // the user said it, not by id, so the question can name it too.
    const proposed = await app.ai.tools.invoke('cancel_task', { task: 'Отменить поездку в Москву' }, {
      write: { actor: 'ai' }, day: '2026-09-10', now: new Date(), approved: [], language: 'ru',
    });
    expect(proposed.ok).toBe(false);
    expect(proposed.confirmation).toBeTruthy();

    const conversation = await app.ai.mentor.chat('Отмени задачу «Отменить поездку в Москву»');
    const fakeTurn: TurnResult = {
      ...conversation,
      reply: 'Отменить задачу «Отменить поездку в Москву»? Она уйдёт из плана.',
      toolCalls: [{ call: { id: 'call-1', name: 'cancel_task', arguments: { task: 'Отменить поездку в Москву' } }, outcome: proposed, durationMs: 1 }],
      confirmations: [proposed.confirmation!],
    };
    const box = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 });
    // Type first, then stub: a message typed before the model is replaced can never reach the network.
    await user.type(box, 'Отмени задачу «Отменить поездку в Москву»');
    const chat = vi.spyOn(app.ai.mentor, 'chat').mockResolvedValue(fakeTurn);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(chat).toHaveBeenCalled();

    // ── the question ────────────────────────────────────────────────────────────
    const card = await screen.findByRole('group', { name: 'Нужно ваше решение' }, { timeout: 20_000 });
    expect(card.textContent).toContain('Отменить задачу «Отменить поездку в Москву»?');
    expect(card.textContent).not.toContain('Cancel the task'); // the engine's English question stays out
    expect(await screen.findByRole('button', { name: 'Разрешить' })).toBeTruthy();
    // …and the task is untouched while the question is open.
    expect((await app.services.tasks.get(task.id))?.status).not.toBe('cancelled');

    // ── the answer ──────────────────────────────────────────────────────────────
    await user.click(screen.getByRole('button', { name: 'Разрешить' }));
    await waitFor(async () => {
      expect((await app.services.tasks.get(task.id))?.status).toBe('cancelled');
    }, { timeout: 20_000 });
    // The card is gone, the outcome is in the chat, and the decision is in the conversation.
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Нужно ваше решение' })).toBeNull());
    expect((await screen.findAllByText(/Готово: отменил задачу/)).length).toBeGreaterThan(0);
    const history = await app.ai.conversations.history(fakeTurn.conversationId, 20);
    expect(history.some((m) => m.content === 'Готово: отменил задачу.')).toBe(true);
  }, 180_000);

  it('keeps the open question across a restart of the screen, and only until it is answered', async () => {
    const app = await openMentor();
    const task = await app.services.tasks.create({ title: 'Съездить за документами', estimated_minutes: 15 });
    const proposed = await app.ai.tools.invoke('cancel_task', { task: 'Съездить за документами' }, {
      write: { actor: 'ai' }, day: '2026-09-10', now: new Date(), approved: [], language: 'ru',
    });
    const turn = await app.ai.mentor.chat('Отмени задачу «Съездить за документами»');
    const answeredTurn: TurnResult = {
      ...turn,
      reply: 'Отменить задачу «Съездить за документами»? Она уйдёт из плана.',
      toolCalls: [{ call: { id: 'call-9', name: 'cancel_task', arguments: { task: 'Съездить за документами' } }, outcome: proposed, durationMs: 1 }],
      confirmations: [proposed.confirmation!],
    };
    // The model's answer is the only stand-in; it is stored through the real conversation service,
    // which is what makes the question survive.
    await app.ai.conversations.addAssistant(turn.conversationId, answeredTurn.reply, {
      provider: 'test', model: 'test', toolCalls: [{ name: 'cancel_task', ok: false, confirmation: proposed.confirmation }],
    });

    // ── the user closes the app with the question open ──────────────────────────
    cleanup();
    window.location.hash = '#/mentor';
    render(<App />);
    const card = await screen.findByRole('group', { name: 'Нужно ваше решение' }, { timeout: 20_000 });
    expect(card.textContent).toContain('Отменить задачу «Съездить за документами»?');
    // A failed call must not come back looking like a success.
    expect(card.ownerDocument.body.textContent).toContain('⚠ отменил задачу');

    await user.click(screen.getByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Нужно ваше решение' })).toBeNull());

    // ── and now it is answered: a reload must not ask again ─────────────────────
    cleanup();
    window.location.hash = '#/mentor';
    render(<App />);
    await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Нужно ваше решение' })).toBeNull();
      expect(document.body.textContent).toContain('Отменено — ничего не менял.');
    });
    expect((await app.services.tasks.get(task.id))?.status).not.toBe('cancelled');
  }, 180_000);

  it('names what it could not identify, and never shows the model its own instruction', async () => {
    const app = await openMentor();
    // Two lab reports: «лабораторную» fits both, so the assistant must ask instead of guessing.
    await app.services.tasks.create({ title: 'Сдать лабораторную по физике', estimated_minutes: 30 });
    await app.services.tasks.create({ title: 'Сдать лабораторную по химии', estimated_minutes: 30 });
    const outcome = await app.ai.tools.invoke('cancel_task', { task: 'лабораторную' }, {
      write: { actor: 'ai' }, day: '2026-09-10', now: new Date(), approved: ['cancel_task'], language: 'ru',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.needs_input_item?.code).toBe('ambiguous');

    const conversation = await app.ai.mentor.chat('Отмени лабораторную');
    vi.spyOn(app.ai.mentor, 'chat').mockResolvedValue({
      ...conversation,
      // What the engine composes for a Russian reader.
      reply: needsInputItemText(outcome.needs_input_item!, true),
      toolCalls: [{ call: { id: 'call-3', name: 'cancel_task', arguments: { task: 'лабораторную' } }, outcome, durationMs: 1 }],
      needsInput: outcome.needsInput ?? null,
      needsInputItem: outcome.needs_input_item ?? null,
    } as TurnResult);

    const box = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 });
    await user.type(box, 'Отмени лабораторную');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    // The chip says what happened, in Russian, and does not claim the task was cancelled.
    const chip = await screen.findByText(/под «лабораторную» подходит несколько/, {}, { timeout: 20_000 });
    expect(chip.textContent).toContain('⚠');
    // The chip carries the reason, not the past tense of a success.
    expect(chip.textContent).not.toContain('отменил');
    // The question names the two candidates instead of telling the assistant to ask.
    expect(document.body.textContent).toContain('Под «лабораторную» подходит несколько');
    expect(document.body.textContent).toContain('«Сдать лабораторную по физике»');
    expect(document.body.textContent).not.toContain('Ask the user which one they mean');
    expect(document.body.textContent).not.toContain('do not pick one yourself');
    // …and neither task was touched.
    const open = await app.services.tasks.backlog(50);
    for (const title of ['Сдать лабораторную по физике', 'Сдать лабораторную по химии']) {
      expect(open.find((t) => t.title === title)?.status).toBe('todo');
    }
  }, 180_000);

  it('does nothing at all when the user says «Отменить»', async () => {
    const app = await openMentor();

    const event = await app.services.calendar.create({ title: 'Встреча с куратором', day: '2026-09-10', start: '12:00', end: '13:00', kind: 'meeting' });
    const proposed = await app.ai.tools.invoke('delete_calendar_event', { title: 'Встреча с куратором', day: '2026-09-10' }, {
      write: { actor: 'ai' }, day: '2026-09-10', now: new Date(), approved: [], language: 'ru',
    });
    const conversation = await app.ai.mentor.chat('Удали встречу с куратором');
    const refusedTurn = {
      ...conversation,
      reply: 'Удалить событие «Встреча с куратором» (2026-09-10)? Это необратимо.',
      toolCalls: [{ call: { id: 'call-2', name: 'delete_calendar_event', arguments: { title: 'Встреча с куратором' } }, outcome: proposed, durationMs: 1 }],
      confirmations: [proposed.confirmation!],
    } as TurnResult;

    const box = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 });
    await user.type(box, 'Удали встречу с куратором');
    const chat = vi.spyOn(app.ai.mentor, 'chat').mockResolvedValue(refusedTurn);
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(chat).toHaveBeenCalled();

    const card = await screen.findByRole('group', { name: 'Нужно ваше решение' }, { timeout: 20_000 });
    expect(card.textContent).toContain('Удалить событие «Встреча с куратором»');
    expect(card.textContent).toContain('необратимо');

    await user.click(await screen.findByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Нужно ваше решение' })).toBeNull());
    expect(await screen.findAllByText(/Отменено — ничего не менял/)).toBeTruthy();
    // The event is still there, exactly as promised.
    expect((await app.services.calendar.get(event.id))?.title).toBe('Встреча с куратором');
  }, 180_000);
});
