// @vitest-environment jsdom
/**
 * UI journey test (req. 73, 74, 75, 93, 95 — and the roadmap's last open item).
 *
 * This drives the **real web client** — the same `App`, `AppProvider` and screens the
 * browser preview renders — through a whole first-run journey:
 *
 *   welcome → basic questionnaire (all 7 blocks, through the DOM) → AI analysis →
 *   adaptive interview → "Вот как я вас понял" → confirm → initial goals →
 *   dashboard → create a task → complete it → profile/memory → restart → data intact.
 *
 * It runs under jsdom in Node, so it also runs in CI where no browser exists; the
 * Playwright smoke job in `release.yml` covers the browser-only surface (service
 * worker, Web Push, real IndexedDB).
 *
 * The app instance behind the screens is a genuine `LifeMentorApp`: real SQLite
 * (node driver) on a temp file, real migrations/services/planner/AI orchestrator, and
 * an unreachable server (local-first: the client must stay usable offline, req. 60).
 * "Restart" closes the connection and reopens the same file (req. 94).
 */
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QUESTIONNAIRE, addDays, assertNoCriticalOverlap, dayKey } from '@lifementor/core';

// The production bootstrap module is replaced by a real-client harness (see the file).
vi.mock('../src/core/app', async () => await import('./support/app-harness'));

import App from '../src/App';
import { disposeHarness, openApp, restartApp } from './support/app-harness';

const user = userEvent.setup();
const uncaught: string[] = [];

beforeAll(() => {
  window.addEventListener('error', (e) => uncaught.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => uncaught.push(`rejection: ${String((e as PromiseRejectionEvent).reason)}`));
});

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
});

afterAll(async () => {
  await disposeHarness();
});

/** Fill every answer widget React renders on the current questionnaire block. */
async function fillVisibleQuestions(container: HTMLElement): Promise<void> {
  for (const textarea of container.querySelectorAll('textarea')) {
    await user.type(textarea, 'Работаю и учусь, хочу расти в разработке и финансах');
  }
  for (const input of container.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    fireEvent.change(input, { target: { value: '2' } });
  }
  for (const input of container.querySelectorAll<HTMLInputElement>('input[type="time"]')) {
    fireEvent.change(input, { target: { value: '07:00' } });
  }
  // single/multi choices are label elements with their own onClick handler
  for (const group of container.querySelectorAll('.mb')) {
    const option = group.querySelector('.q-option');
    if (option && !group.querySelector('.q-option.sel')) await user.click(option);
  }
}

async function button(name: string | RegExp) {
  return await screen.findByRole('button', { name }, { timeout: 20_000 });
}

describe('first run in the browser client (dom, real engine)', () => {
  it('walks welcome → questionnaire → adaptive interview → confirmed model → dashboard', async () => {
    render(<App />);

    // ── Gate: the first screen explains what the app is going to do (req. 74, 100) ──
    expect(await screen.findByText('Сначала мне нужно понять, кто вы', {}, { timeout: 30_000 })).toBeTruthy();
    await user.click(await button(/Начать знакомство/));

    // ── Stage 1: the universal questionnaire, block by block ──────────────────────
    const total = QUESTIONNAIRE.length;
    for (let block = 1; block <= total; block += 1) {
      await screen.findByText(`Блок ${block} / ${total}`, {}, { timeout: 20_000 });
      await fillVisibleQuestions(document.body);
      await user.click(screen.getByRole('button', { name: 'Сохранить и дальше' }));
    }

    // ── Stage 2: deterministic analysis of the answers, then the adaptive interview ──
    await user.click(await button(/Перейти к уточняющим вопросам/));

    // The interview asks only questions that improve the model; answer each one.
    const currentQuestion = () => document.querySelector('.ob-card h3')?.textContent ?? '';
    for (let i = 0; i < 12; i += 1) {
      const answerBtn = screen.queryByRole('button', { name: 'Ответить' });
      if (!answerBtn) break;
      const asked = currentQuestion();
      const textarea = document.querySelector('.ob-card textarea');
      if (textarea) await user.type(textarea, 'Хочу доход от собственных продуктов, начинаю с backend');
      await user.click(answerBtn);
      await waitFor(() => expect(currentQuestion() === asked).toBe(false), { timeout: 15_000 });
    }

    // ── Stage 3: "Вот как я вас понял" — assumptions labelled, every fact editable ──
    expect(await screen.findByText('Вот как я вас понял', {}, { timeout: 20_000 })).toBeTruthy();
    const modelItems = document.querySelectorAll('.model-item');
    expect(modelItems.length).toBeGreaterThan(0);
    await user.click(await button('Подтвердить модель'));

    // ── Stage 4: initial goals → skills → knowledge → first plan ──────────────────
    expect(await screen.findByText('Первые цели', {}, { timeout: 20_000 })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /Запустить систему/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /Запустить систему/ }));

    // ── The dashboard is the product's answer to "what do I do now?" (req. 51) ────
    expect(await screen.findByText(/👋/, {}, { timeout: 40_000 })).toBeTruthy();
    // The dashboard truly rendered: sidebar navigation + the "today" card.
    expect(screen.getAllByText('Сегодня').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Главная').length).toBeGreaterThan(0);

    // The confirmation really created a user model + goals in the database (req. 4, 75).
    const app = openApp();
    expect(app).not.toBeNull();
    expect(await app!.services.settings.get('flags')).toMatchObject({ onboarding_completed: true });
    const goals = await app!.services.goals.list({ status: 'active' });
    expect(goals.length).toBeGreaterThan(0);
    expect((await app!.services.skills.list()).length).toBeGreaterThan(0);
  }, 180_000);

  it('creates and completes a task in the Today screen, and keeps it across a restart', async () => {
    // This runs after the journey: onboarding is done and the app is open on the same DB.
    window.location.hash = '#/today';
    render(<App />);

    expect(await screen.findByText('Все задачи на день', {}, { timeout: 30_000 })).toBeTruthy();

    // ── Create a task through the real modal ─────────────────────────────────────
    async function addTask(text: string): Promise<void> {
      await user.click(await button(/Задача$/));
      const modal = (document.querySelector('.modal') as HTMLElement) ?? null;
      expect(modal).toBeTruthy();
      await user.type(within(modal).getByPlaceholderText('Что нужно сделать'), text);
      await user.click(within(modal).getByRole('button', { name: 'Создать' }));
      expect((await screen.findAllByText(text, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);
    }

    await addTask('Собрать портфолио-страницу');

    // ── Complete it: the checkbox writes through to SQLite immediately (req. 9) ───
    const row = screen.getAllByText('Собрать портфолио-страницу').map((el) => el.closest('.row') as HTMLElement)
      .find((el) => el && within(el).queryByRole('checkbox')) as HTMLElement;
    expect(row).toBeTruthy();
    await user.click(within(row).getByRole('checkbox') as HTMLInputElement);
    await waitFor(async () => {
      const tasks = await openApp()!.repos.tasks.find({ title: 'Собрать портфолио-страницу' });
      expect(tasks[0]?.status).toBe('done');
    });

    // A second, unfinished task: it is what the user must find again after a restart.
    await addTask('Проверить сохранность после перезапуска');

    // ── Memory screen: what the AI knows about me is visible and editable (req. 53) ─
    window.location.hash = '#/profile';
    await waitFor(() => expect(screen.getByText('Что ИИ помнит')).toBeTruthy(), { timeout: 20_000 });
    // The model the user confirmed during onboarding is what the screen shows (req. 52, 53).
    const model = await openApp()!.services.profile.model();
    expect(model.field_count).toBeGreaterThan(0);
    expect(await screen.findByText(/фактов · подтверждено/)).toBeTruthy();

    // ── Restart: close the process, open the same database (req. 94) ─────────────
    cleanup();
    await restartApp();
    window.location.hash = '#/';
    render(<App />);

    // A returning user is put back on the screen they left (req. 13) — here the profile — and
    // onboarding is never shown again.
    expect(await screen.findByText('Что ИИ помнит', {}, { timeout: 40_000 })).toBeTruthy();
    expect(screen.queryByText('Сначала мне нужно понять, кто вы')).toBeNull();

    window.location.hash = '#/dashboard';
    expect(await screen.findByText(/👋/, {}, { timeout: 30_000 })).toBeTruthy();

    window.location.hash = '#/today';
    expect(await screen.findByText('Все задачи на день', {}, { timeout: 30_000 })).toBeTruthy();
    // The open task is back in today's list (it can appear in the plan and in the task list).
    expect((await screen.findAllByText('Проверить сохранность после перезапуска', {}, { timeout: 20_000 })).length).toBeGreaterThan(0);
    // …and the work already marked done is still done (once saved, never lost — req. 94).
    expect((await openApp()!.repos.tasks.find({ title: 'Собрать портфолио-страницу' }))[0]?.status).toBe('done');
  }, 180_000);

  it('mentor chat answers offline and acts on the database through tools (req. 22, 23, 24)', async () => {
    window.location.hash = '#/mentor';
    render(<App />);

    const box = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 });
    await user.type(box, 'Add a task: прочитать главу 3, 30 minutes, tomorrow');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    // The assistant executed a real tool: the task exists in SQLite, scheduled for tomorrow.
    const tomorrow = dayKey(addDays(new Date(), 1));
    await waitFor(async () => {
      const created = (await openApp()!.services.tasks.listForDay(tomorrow)).find((t) => /главу 3/i.test(t.title));
      expect(created?.estimated_minutes).toBe(30);
    }, { timeout: 30_000 });

    // …and the UI shows the turn plus the tool that ran (no fabricated "I did it").
    const chip = document.querySelector('.tool-chip') as HTMLElement | null;
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('✓');
    expect(document.querySelectorAll('.msg.assistant').length).toBeGreaterThan(0);

    // The conversation is durable: a fresh mount reloads it from the database.
    cleanup();
    window.location.hash = '#/mentor';
    render(<App />);
    expect((await screen.findAllByText(/прочитать главу 3/, {}, { timeout: 30_000 })).length).toBeGreaterThan(0);
  }, 120_000);

  it('never plans over a real event: the exam stays immovable (req. 31, 82, 83)', async () => {
    const today = dayKey();

    window.location.hash = '#/calendar';
    render(<App />);
    await user.click(await button(/Событие$/));
    const modal = document.querySelector('.modal') as HTMLElement;
    await user.type(within(modal).getByPlaceholderText(/Экзамен, встреча, дорога/), 'Экзамен по математике');
    const [dateInput, startInput, endInput] = [
      ...modal.querySelectorAll<HTMLInputElement>('input[type="date"], input[type="time"]'),
    ];
    fireEvent.change(dateInput, { target: { value: today } });
    fireEvent.change(startInput, { target: { value: '14:00' } });
    fireEvent.change(endInput, { target: { value: '15:00' } });
    // Type = exam, priority = fixed: the user says this one cannot move.
    const [kindSelect, prioritySelect] = [...modal.querySelectorAll<HTMLSelectElement>('select')];
    fireEvent.change(kindSelect, { target: { value: 'exam' } });
    fireEvent.change(prioritySelect, { target: { value: 'critical' } });
    await user.click(within(modal).getByRole('button', { name: 'Сохранить' }));

    await waitFor(async () => {
      const events = await openApp()!.services.calendar.listDay(today);
      expect(events.some((e) => e.title === 'Экзамен по математике')).toBe(true);
    }, { timeout: 20_000 });

    // Ask the planner to fill the day through the UI.
    window.location.hash = '#/today';
    await waitFor(() => expect(screen.getByText('Все задачи на день')).toBeTruthy(), { timeout: 30_000 });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Построить план|Пересобрать остаток/ }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: /Построить план|Пересобрать остаток/ })[0]);

    const planned = await waitFor(async () => {
      const plan = await openApp()!.services.planner.buildDay(today);
      expect(plan.slots.length).toBeGreaterThan(0);
      return plan;
    }, { timeout: 30_000 });

    // The engine's own safety net: nothing is scheduled over the exam (req. 31).
    const busy = await openApp()!.services.calendar.busyBlocks(today);
    const violations = assertNoCriticalOverlap(planned, busy);
    expect(violations, JSON.stringify({ violations, busy, slots: planned.slots }, null, 1)).toEqual([]);
    const exam = busy.find((b) => b.title === 'Экзамен по математике');
    expect(exam, JSON.stringify(busy)).toMatchObject({ start: 14 * 60, end: 15 * 60, immovable: true });

    // And the screen says the same thing: the event is listed as a fixed commitment.
    expect(await screen.findByText('Обязательные события', {}, { timeout: 20_000 })).toBeTruthy();
    expect(screen.getAllByText('Экзамен по математике').length).toBeGreaterThan(0);
  }, 120_000);

  it('drives the strategy ladder: add a direction, close it with a reason, keep the history (req. 45, 46, 79–81)', async () => {
    // The strategy engine (horizons, option comparison, immutable change history) had no screen at
    // all: implemented in phase 7 and unreachable from the UI. This walks the screen a user gets.
    window.location.hash = '#/strategy';
    render(<App />);

    // «Стратегия» is both the sidebar entry and the heading — the usual trap with these screens.
    await waitFor(() => expect(screen.getAllByText('Стратегия').length).toBeGreaterThan(1), { timeout: 30_000 });
    // The whole ladder is on screen, and the history panel exists (it is empty until we change
    // something, which is the point). Onboarding already seeds directions from the confirmed goals,
    // so this does not assume an empty strategy.
    expect((await screen.findAllByText(/3–5 лет/)).length).toBeGreaterThan(0);
    expect(await screen.findByText('История изменений', {}, { timeout: 30_000 })).toBeTruthy();

    // ── Build the ladder from the goals confirmed during onboarding ───────────────
    await user.click(await button('Собрать из целей'));
    await waitFor(async () => {
      const ladder = await openApp()!.services.strategy.ladder();
      expect(ladder.some((level) => level.items.length > 0)).toBe(true);
    }, { timeout: 20_000 });

    // ── Add a direction of our own to the far horizon ────────────────────────────
    const farHorizon = (await screen.findByText('3–5 лет', {}, { timeout: 20_000 })).closest('.card') as HTMLElement;
    await user.click(within(farHorizon).getByRole('button', { name: '+ направление' }));
    const modal = document.querySelector('.modal') as HTMLElement;
    expect(modal).toBeTruthy();
    await user.type(within(modal).getByPlaceholderText('Что для вас правда на этом горизонте'), 'Жить с дохода от своих продуктов');
    await user.click(within(modal).getByRole('button', { name: 'Добавить' }));

    await waitFor(async () => {
      const items = await openApp()!.services.strategy.list('3-5y');
      expect(items.map((i) => i.title)).toContain('Жить с дохода от своих продуктов');
    }, { timeout: 20_000 });
    expect((await screen.findAllByText('Жить с дохода от своих продуктов')).length).toBeGreaterThan(0);

    // ── Close one of them with a reason: the reason must survive in the history ───
    const goalRow = (await screen.findAllByText(/Жить с дохода от своих продуктов/))[0].closest('.row') as HTMLElement;
    await user.click(within(goalRow).getByRole('button', { name: 'Закрыть' }));
    const dropModal = document.querySelector('.modal') as HTMLElement;
    await user.type(within(dropModal).getByPlaceholderText('Например: выбрал другое направление'), 'Выбрал другое направление');
    await user.click(within(dropModal).getByRole('button', { name: 'Закрыть направление' }));

    await waitFor(async () => {
      const changes = await openApp()!.services.strategy.changes({ limit: 30 });
      expect(changes.some((c) => c.reason === 'Выбрал другое направление')).toBe(true);
    }, { timeout: 20_000 });
    expect((await screen.findAllByText(/Выбрал другое направление/, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);

    // ── The option comparison answers with reasoning, never with a promise ───────
    const firstOption = screen.getAllByPlaceholderText('Например: фриланс на 10 ч/нед')[0];
    await user.type(firstOption, 'Фриланс по 10 часов в неделю');
    expect((await screen.findAllByText(/не прогноз успеха|сравнивают варианты/i, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);

    // ── And it all survives a restart, because it lives in SQLite (req. 94) ───────
    await restartApp();
    render(<App />);
    expect((await screen.findAllByText(/Выбрал другое направление/, {}, { timeout: 40_000 })).length).toBeGreaterThan(0);
  }, 180_000);

  it('returns to the last screen and keeps an unsent message (req. 13)', async () => {
    window.location.hash = '#/mentor';
    render(<App />);

    // Half-typed message the user never got to send.
    const input = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 }) as HTMLTextAreaElement;
    await user.type(input, 'Черновик: уточнить расписание на неделю');
    await waitFor(async () => {
      const draft = await openApp()!.services.recovery.readDraft<{ text?: string }>('mentor');
      expect(draft?.text).toBe('Черновик: уточнить расписание на неделю');
    }, { timeout: 20_000 });

    // The process dies (tab closed, phone killed): the next launch starts at `/`.
    cleanup();
    await restartApp();
    window.location.hash = '#/';
    render(<App />);

    // …and the user gets their screen and their text back, marked as a draft.
    await waitFor(() => expect(window.location.hash).toBe('#/mentor'), { timeout: 40_000 });
    const restored = await screen.findByPlaceholderText(/завтра в 15:00 экзамен/, {}, { timeout: 30_000 }) as HTMLTextAreaElement;
    expect(restored.value).toBe('Черновик: уточнить расписание на неделю');
    expect(await screen.findByText('черновик восстановлен', {}, { timeout: 20_000 })).toBeTruthy();

    // The plan check the recovery report describes is visible in Settings → Диагностика.
    window.location.hash = '#/settings';
    await user.click(await screen.findByText('Диагностика', {}, { timeout: 30_000 }));
    expect(await screen.findByText('Восстановление после сбоя', {}, { timeout: 20_000 })).toBeTruthy();
    expect(await screen.findByText('Шаги проверки', {}, { timeout: 20_000 })).toBeTruthy();
    await waitFor(() => expect(openApp()!.recoveryReport?.ok).toBe(true), { timeout: 20_000 });

    // Clean up: sending clears the draft (the assertion above proved the restore).
    window.location.hash = '#/mentor';
    await waitFor(() => expect(screen.getByPlaceholderText(/завтра в 15:00 экзамен/)).toBeTruthy(), { timeout: 30_000 });
    await user.click(await button('Очистить'));
    await waitFor(async () => {
      expect(await openApp()!.services.recovery.readDraft('mentor')).toBeNull();
    }, { timeout: 20_000 });
  }, 180_000);

  it('never let a single uncaught error reach the window (req. 68, 95)', () => {
    expect(uncaught).toEqual([]);
  });
});
