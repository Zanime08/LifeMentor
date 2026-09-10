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
    // The real client decides the language on the first launch (browser language). The harness starts
    // from engine defaults ('en'), so the confirmation step is asserted in both modes further down.
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

    // A task with a deadline today: the planner explains on the block *why* it is there, and that
    // explanation is one of the sentences that used to arrive in English («due today»).
    await openApp()!.services.tasks.create({ title: 'Сдать лабораторную', due_date: today, estimated_minutes: 40, priority: 'P1' });

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

    // Every remark the plan makes about itself exists in the user's language as well as in English
    // (the English form is what the AI context and the export read).
    expect(planned.warning_items?.length ?? 0).toBe(planned.warnings.length);
    for (const slot of planned.slots.filter((sl) => sl.generated_title)) {
      expect(slot.generated_title, `блок «${slot.title}» без структурированного названия`).toBeTruthy();
    }

    // The plan the user reads is Russian: the planner used to print its own English sentences
    // straight into the plan («fixed commitment — nothing is scheduled over this», «due today»),
    // and they appeared on the primary screen of the app.
    const plannedContent = (document.querySelector('.content')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(plannedContent).toContain('срок сегодня');
    expect(plannedContent).toContain('Свободное время');
    for (const english of ['Free time', 'fixed commitment', 'item(s)', 'due today', 'Spaced repetition', 'serves a goal', 'marked important']) {
      expect(plannedContent, `в плане на экране осталась английская фраза «${english}»`).not.toContain(english);
    }
  }, 120_000);

  it('never books an overlap silently: the event form says what it collides with (req. 31, 82, 83)', async () => {
    const today = dayKey();

    window.location.hash = '#/calendar';
    render(<App />);
    await user.click(await button(/Событие$/));
    const modal = document.querySelector('.modal') as HTMLElement;
    await user.type(within(modal).getByPlaceholderText(/Экзамен, встреча, дорога/), 'Консультация с научным руководителем');
    const [dateInput, startInput, endInput] = [
      ...modal.querySelectorAll<HTMLInputElement>('input[type="date"], input[type="time"]'),
    ];
    fireEvent.change(dateInput, { target: { value: today } });
    // 14:30–15:30 runs into the exam (14:00–15:00) created by the previous test.
    fireEvent.change(startInput, { target: { value: '14:30' } });
    fireEvent.change(endInput, { target: { value: '15:30' } });

    // The form says it out loud, naming the event it would sit on top of.
    expect(await within(modal).findByText(/Время пересекается/, {}, { timeout: 20_000 })).toBeTruthy();
    expect(within(modal).getByText(/Экзамен по математике/)).toBeTruthy();

    // The first click only warns: nothing is written yet.
    const before = (await openApp()!.services.calendar.listDay(today)).length;
    await user.click(within(modal).getByRole('button', { name: 'Сохранить' }));
    expect((await openApp()!.services.calendar.listDay(today)).length).toBe(before);

    // The second click is explicit consent, and then it is saved.
    await user.click(await within(modal).findByRole('button', { name: 'Сохранить всё равно' }));
    await waitFor(async () => {
      const events = await openApp()!.services.calendar.listDay(today);
      expect(events.some((e) => e.title === 'Консультация с научным руководителем')).toBe(true);
    }, { timeout: 20_000 });
  }, 120_000);

  it('tells the user which projects are at risk (req. 41)', async () => {
    window.location.hash = '#/today';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });
    // A project that cannot make its deadline: due in three days, nothing done yet.
    await openApp()!.services.projects.create({
      title: 'Собрать портфолио до конца недели',
      deadline: dayKey(addDays(new Date(), 3)),
      status: 'active',
    });

    window.location.hash = '#/projects';
    expect(await screen.findByText(/Требуют внимания/, {}, { timeout: 30_000 })).toBeTruthy();
    expect((await screen.findAllByText('Собрать портфолио до конца недели')).length).toBeGreaterThan(0);
    // The reason is in the user's language, not the engine's: it says deadline and progress.
    expect(await screen.findByText(/риск не успеть к дедлайну/, {}, { timeout: 20_000 })).toBeTruthy();
    expect(await screen.findByText(/дедлайн \d{4}-\d{2}-\d{2} · готово 0%/, {}, { timeout: 20_000 })).toBeTruthy();
  }, 120_000);

  it('lets the user connect and remove knowledge nodes (req. 47–49)', async () => {
    window.location.hash = '#/today';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });
    const app = openApp()!;
    await app.services.knowledge.addNode({ title: 'HTTP/REST', domain: 'backend' });
    await app.services.knowledge.addNode({ title: 'SQL и индексы', domain: 'backend' });

    // The map was add-only: nodes could be created and edited, but a wrong node could never be
    // removed and no two nodes could ever be connected by hand.
    window.location.hash = '#/knowledge';
    const svg = await waitFor(() => {
      const el = document.querySelector('.kmap');
      if (!el) throw new Error('карта ещё не построена');
      return el as unknown as HTMLElement;
    }, { timeout: 30_000 });
    fireEvent.click(within(svg).getByText('HTTP/REST'));

    const modal = document.querySelector('.modal') as HTMLElement;
    const selects = [...modal.querySelectorAll<HTMLSelectElement>('select')];
    const nodeSelect = selects.find((s) => s.querySelector('option')?.textContent === 'К какому узлу…');
    const relationSelect = selects.find((s) => s.querySelector('option')?.textContent === 'связано');
    expect(nodeSelect, 'форма связи есть в карточке узла').toBeTruthy();
    const target = [...nodeSelect!.querySelectorAll('option')].find((o) => o.textContent === 'SQL и индексы');
    expect(target).toBeTruthy();
    fireEvent.change(nodeSelect!, { target: { value: target!.value } });
    fireEvent.change(relationSelect!, { target: { value: 'prerequisite' } });
    await user.click(within(modal).getByRole('button', { name: 'Связать' }));

    await waitFor(async () => {
      const map = await openApp()!.services.knowledge.map();
      expect(map.relations.some((r) => r.relation === 'prerequisite')).toBe(true);
    }, { timeout: 20_000 });
    expect((await within(modal).findAllByText(/предшествует/)).length).toBeGreaterThan(0);

    // Removing is a two-step inside the same dialog — never a second modal on top of it.
    await user.click(within(modal).getByRole('button', { name: 'Удалить узел' }));
    await user.click(await within(modal).findByRole('button', { name: 'Удалить навсегда' }));
    await waitFor(async () => {
      const map = await openApp()!.services.knowledge.map();
      expect(map.nodes.some((n) => n.title === 'HTTP/REST')).toBe(false);
    }, { timeout: 20_000 });
  }, 180_000);

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

    // ── The connectivity audit speaks Russian too (req. 45): the engine's warnings are
    //    English internal strings, the screen words them from their codes.
    const engineWarnings = (await openApp()!.services.strategy.audit()).flatMap((level) => level.warning_items ?? []);
    expect(engineWarnings.length, 'лестница заполнена не полностью — движку есть что сказать').toBeGreaterThan(0);
    const page = document.querySelector('.content')?.textContent ?? '';
    expect(page).not.toMatch(/No active [a-z0-9-]+ direction|None of these are linked|have no [a-z0-9-]+ direction above/);
    const auditCard = await screen.findByText('Проверка связности', {}, { timeout: 20_000 });
    const auditText = (auditCard.closest('.card') as HTMLElement).textContent ?? '';
    expect(auditText).toMatch(/На горизонте «.+» пока нет ни одного направления|не связано с целью|нет направления выше/);
    expect(auditText).not.toMatch(/direction|linked to a goal/);

    // ── The option comparison answers with reasoning, never with a promise ───────
    const firstOption = screen.getAllByPlaceholderText('Например: фриланс на 10 ч/нед')[0];
    await user.type(firstOption, 'Фриланс по 10 часов в неделю');
    expect((await screen.findAllByText(/не прогноз успеха|сравнивают варианты/i, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);

    // ── And it all survives a restart, because it lives in SQLite (req. 94) ───────
    await restartApp();
    render(<App />);
    expect((await screen.findAllByText(/Выбрал другое направление/, {}, { timeout: 40_000 })).length).toBeGreaterThan(0);
  }, 180_000);

  it('lets the user search their own long-term memory (req. 51–53)', async () => {
    window.location.hash = '#/profile';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });
    await openApp()!.services.memory.save({
      kind: 'preference',
      content: 'Предпочитает учиться утром, до работы',
      importance: 0.8,
      confidence: 'confirmed',
      source: 'user_provided',
    });

    const box = await screen.findByPlaceholderText(/Поиск по памяти/, {}, { timeout: 30_000 }) as HTMLInputElement;
    await user.type(box, 'утром');
    expect(await screen.findByText('Предпочитает учиться утром, до работы', {}, { timeout: 20_000 })).toBeTruthy();
    // The hit says *why* it matched: the memory searches by words and by meaning.
    expect((await screen.findAllByText(/по словам|по смыслу/)).length).toBeGreaterThan(0);

    // A query that matches nothing says so, instead of showing an empty card.
    await user.clear(box);
    await user.type(box, 'зыбучий песок на Марсе');
    expect(await screen.findByText(/Ничего не нашлось/, {}, { timeout: 20_000 })).toBeTruthy();
  }, 120_000);

  it('shows the user model in Russian, not in the engine\'s English (req. 6, 7)', async () => {
    window.location.hash = '#/profile';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });
    // The client decides this at the first launch, from the device language; here we set it the way
    // the bootstrap does and force the screen to reload.
    await openApp()!.services.settings.setMany({ ai: { language: 'ru' }, profile: { locale: 'ru' } });
    window.location.hash = '#/today';
    window.location.hash = '#/profile';

    const head = await screen.findByText('Модель пользователя', {}, { timeout: 30_000 });
    const card = head.closest('.card') as HTMLElement;
    const text = card.textContent ?? '';
    // Labels and values are worded by the interface (the engine's English strings are internal).
    expect(text).toMatch(/Чего вы хотите достичь/);
    expect(text).not.toMatch(/Age range|Education|Current activity|What you want to achieve|Interests|Sharpest time of day/);
    expect(text).not.toMatch(/Studying|Working full-time|Morning|Afternoon/);
    // The values the user typed themselves are untouched.
    expect(text).toMatch(/Работаю и учусь/);
  }, 120_000);

  it('shows the reviews in Russian, not as stored JSON (req. 77, 78)', async () => {
    window.location.hash = '#/today';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });
    const app = openApp()!;
    // A week with two finished tasks and one the user pushed away, saying why.
    const first = await app.services.tasks.create({ title: 'Разобрать главу по алгоритмам' });
    const second = await app.services.tasks.create({ title: 'Написать тесты для парсера' });
    const third = await app.services.tasks.create({ title: 'Свести бюджет за месяц' });
    await app.services.tasks.complete(first.id, { actual_minutes: 45 });
    await app.services.tasks.complete(second.id, { actual_minutes: 45 });
    await app.services.tasks.postpone(third.id, { reason: 'lack_of_time' });

    await app.services.weeklyReviews.create();
    await app.services.monthlyReviews.create();

    window.location.hash = '#/progress';
    const weekly = await screen.findByText(/Неделя с/, {}, { timeout: 30_000 });
    const card = weekly.closest('.list-item') as HTMLElement;
    const text = card.textContent ?? '';

    // The numbers are there, in Russian, as sentences a person can read…
    expect(text).toMatch(/Сделано задач: \d+ · /);
    expect(text).toMatch(/Перенесено задач: \d+/);
    // …the user's own reason for postponing is named in their own words…
    expect(text).toMatch(/Тормозило: Не хватает времени — 1/);
    // …and nothing of the stored machine form leaks into the screen.
    expect(text).not.toContain('"code"');
    expect(text).not.toContain('tasks completed');
    expect(text).not.toMatch(/\[\s*\{/);

    // The monthly review proposes a strategy in Russian instead of the engine's English prose.
    const month = (await screen.findByText(/^\d{4}-\d{2}$/, {}, { timeout: 20_000 })).closest('.list-item') as HTMLElement;
    const monthText = month.textContent ?? '';
    expect(monthText).toMatch(/Стратегия на следующий месяц: не больше 3 активных приоритетов/);
    expect(monthText).not.toContain('Suggested strategy for next month');
    expect(monthText).toMatch(/задач: \d+/);

    // And the 30-day view of why work slips is on the same screen (req. 29: patterns, not raw stats).
    expect(await screen.findByText(/За 30 дней перенесено \d+ (задача|задачи|задач) · причины: Не хватает времени — 1/, {}, { timeout: 20_000 })).toBeTruthy();
  }, 180_000);

  it('lets the user mute one kind of notification without muting the rest (req. 85)', async () => {
    window.location.hash = '#/settings';
    render(<App />);
    await waitFor(() => expect(openApp()).not.toBeNull(), { timeout: 30_000 });

    // Settings → Уведомления: the engine has always had per-type preferences, but nothing in the
    // interface (or anywhere else) ever wrote them.
    // The settings tab (class `q-option`), not the shell's notification bell — both are named
    // "Уведомления" and the bell would navigate away from this screen. The screen itself arrives as
    // its own chunk (screens are lazy), so wait for the tab rather than for the first button with
    // that name — the shell's bell is already there.
    const tab = await waitFor(() => {
      const found = screen.getAllByRole('button', { name: 'Уведомления' }).find((b) => b.className.includes('q-option'));
      expect(found, 'вкладка «Уведомления»').toBeTruthy();
      return found!;
    }, { timeout: 30_000 });
    await user.click(tab);
    const toggle = await screen.findByRole('button', { name: /Важные новости/ }, { timeout: 20_000 });
    expect(toggle.textContent).toContain('✓');
    await user.click(toggle);

    await waitFor(async () => {
      const prefs = await openApp()!.services.notifications.preferences();
      expect(prefs.important_news?.enabled).toBe(0);
    }, { timeout: 20_000 });
    expect(await screen.findByRole('button', { name: /✕ Важные новости/ }, { timeout: 20_000 })).toBeTruthy();

    // A fresh profile has no per-type rows at all: every kind is on by default and the override is
    // written only when the user asks for it (the row that used to be created at first launch froze
    // quiet hours and the daily budget).
    // …and the engine refuses to deliver that kind while the others keep working.
    const muted = await openApp()!.services.notifications.create({
      type: 'important_news', title: 'Новость', body: 'Важное событие с объяснением, почему оно важно',
      importance: 0.6, dedupe_key: 'ui-news-1',
    });
    expect(muted).toMatchObject({ delivered: false, reason: 'type_disabled' });
    const allowed = await openApp()!.services.notifications.create({
      type: 'task_reminder', title: 'Задача', body: 'Через 10 минут: дописать функцию авторизации',
      importance: 0.5, dedupe_key: 'ui-task-1', force: true,
    });
    expect(allowed.delivered).toBe(true);
  }, 120_000);

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

  it('opens every screen of the app without a crash (req. 68, 95)', async () => {
    // A sweep, not a deep test: it visits every route the sidebar offers. This is what caught the
    // Knowledge screen dying with "Rendered more hooks than during the previous render" — a hook
    // declared after an early return meant the screen never rendered at all outside the loading
    // spinner. Errors land in `uncaught` and are asserted by the test below.
    // Each screen must print its own heading (or, for the chat, its own input) inside `.content` —
    // "the shell is there" is not enough: a screen stuck on its loading spinner keeps the shell.
    // The spinners say «Загружаю проекты…», so the markers below cannot match them by accident.
    const contentText = () => (document.querySelector('.content')?.textContent ?? '').replace(/\s+/g, ' ');
    const heading = (text: RegExp) => () => text.test(contentText());
    const screens: { route: string; ok: () => boolean; what: string }[] = [
      { route: '/dashboard', ok: heading(/👋/), what: 'приветствие' },
      // The chat's marker is a placeholder attribute, so it is not part of textContent.
      { route: '/mentor', ok: () => !!document.querySelector('.content textarea[placeholder^="Например: завтра в 15:00"]'), what: 'поле ввода' },
      { route: '/today', ok: heading(/Сегодня/), what: 'заголовок' },
      { route: '/calendar', ok: heading(/Календарь/), what: 'заголовок' },
      { route: '/goals', ok: heading(/Цели/), what: 'заголовок' },
      { route: '/learning', ok: heading(/Обучение/), what: 'заголовок' },
      { route: '/projects', ok: heading(/Проекты/), what: 'заголовок' },
      { route: '/skills', ok: heading(/Навыки/), what: 'заголовок' },
      { route: '/knowledge', ok: heading(/Карта знаний/), what: 'заголовок' },
      { route: '/news', ok: heading(/Новости/), what: 'заголовок' },
      { route: '/strategy', ok: heading(/Стратегия/), what: 'заголовок' },
      { route: '/progress', ok: heading(/Прогресс/), what: 'заголовок' },
      { route: '/profile', ok: heading(/Мой профиль/), what: 'заголовок' },
      { route: '/settings', ok: heading(/Настройки/), what: 'заголовок' },
    ];
    window.location.hash = '#/dashboard';
    render(<App />);
    await waitFor(() => expect(document.querySelector('.shell')).toBeTruthy(), { timeout: 30_000 });
    for (const { route, ok, what } of screens) {
      window.location.hash = `#${route}`;
      await waitFor(() => expect(ok(), `экран ${route}: не найден ${what}`).toBe(true), { timeout: 20_000 });
    }
    expect(uncaught, `во время обхода экранов: ${uncaught.join(' | ')}`).toEqual([]);
  }, 180_000);

  it('never let a single uncaught error reach the window (req. 68, 95)', () => {
    expect(uncaught).toEqual([]);
  });
});
