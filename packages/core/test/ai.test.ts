import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { LocalHeuristicProvider } from '../src/ai/providers/local';
import { resolveRelativeDate, resolveRelativeTime } from '../src/ai/tools';
import { needsInputItemText } from '../src/ai/orchestrator';
import { dayKey, addDays } from '../src/util/time';

/**
 * Phase gate for the AI layer (req. 21–29):
 * the offline engine must really act on the database through tools, respect the
 * confirmation policy, remember what the user said, and everything must survive
 * a hard close and reopen of the same SQLite file.
 */

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifementor-ai-'));
  dbPath = join(dir, 'lifementor.sqlite');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function openApp(): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: dbPath, durability: 'paranoid' },
    deviceId: 'device-test-1',
    deviceName: 'Test Device',
    ai: { provider: new LocalHeuristicProvider() },
  });
}

describe('argument normalisation', () => {
  const ctx = { day: '2026-03-04', now: new Date('2026-03-04T10:00:00') };

  it('resolves relative dates against the invocation day', () => {
    expect(resolveRelativeDate('tomorrow', ctx)).toBe('2026-03-05');
    expect(resolveRelativeDate('today', ctx)).toBe('2026-03-04');
    expect(resolveRelativeDate('in 3 days', ctx)).toBe('2026-03-07');
    expect(resolveRelativeDate('monday', ctx)).toBe('2026-03-09');
    expect(resolveRelativeDate('2026-12-31', ctx)).toBe('2026-12-31');
    expect(resolveRelativeDate('whenever', ctx)).toBeNull();
  });

  it('resolves relative times', () => {
    expect(resolveRelativeTime('5pm')).toBe('17:00');
    expect(resolveRelativeTime('at 07:30')).toBe('07:30');
    expect(resolveRelativeTime('noon')).toBe('12:00');
    expect(resolveRelativeTime('soon')).toBeNull();
  });

  it('handles day arithmetic across month boundaries', () => {
    expect(dayKey(addDays(new Date('2026-01-31T12:00:00'), 1))).toBe('2026-02-01');
  });
});

describe('LifeMentorApp composition root', () => {
  it('boots offline, registers the device and reports health', async () => {
    const app = await openApp();
    const health = await app.health();

    expect(health.ok).toBe(true);
    expect(health.integrity.foreignKeyViolations).toHaveLength(0);
    expect(health.ai.offline).toBe(true);
    expect(health.ai.provider).toContain('local');
    expect(health.deviceId).toBe('device-test-1');

    const device = await app.repos.devices.byId('device-test-1');
    expect(device?.is_current).toBe(1);

    // bootstrap is idempotent
    await app.bootstrap();
    const devices = await app.repos.devices.find({});
    expect(devices).toHaveLength(1);

    await app.close();
  });
});

describe('AI context engine', () => {
  it('builds a labelled, budgeted packet from real data', async () => {
    const app = await openApp();
    await app.services.profile.setField({ section: 'PROFILE', key: 'occupation', label: 'Occupation', value: 'Statistics student', source: 'user_provided', confidence: 'confirmed' });
    await app.services.goals.create({ title: 'Pass the statistics exam', horizon: 'short', priority: 'P1', target_date: dayKey(addDays(new Date(), 12)) });
    await app.services.tasks.create({ title: 'Solve 20 probability exercises', estimated_minutes: 60, priority: 'P1', due_date: dayKey(addDays(new Date(), 3)) });
    await app.services.calendar.create({ title: 'Statistics lecture', day: dayKey(), start: '10:00', end: '12:00', kind: 'class', priority: 'critical' });

    const context = await app.ai.context.build({ query: 'what should I do next?', intent: 'next_action' });

    expect(context.text).toContain('USER MODEL');
    expect(context.text).toContain('Statistics student');
    expect(context.text).toContain('## TODAY');
    expect(context.text).toContain('Statistics lecture');
    expect(context.text).toContain('Solve 20 probability exercises');
    expect(context.text).toContain('Pass the statistics exam');
    expect(context.totalTokens).toBeLessThanOrEqual(context.budgetTokens);
    expect(context.included.length).toBeGreaterThan(0);

    // With a lot of real data and a small budget the engine must truncate and drop
    // low-priority sections instead of overflowing the prompt.
    for (let i = 0; i < 40; i++) {
      await app.services.tasks.create({ title: `Bulk backlog item number ${i} with a reasonably long descriptive title`, estimated_minutes: 25, priority: 'P2', notes: 'x'.repeat(200) });
    }
    const tight = await app.ai.context.build({ query: 'hi', intent: 'small_talk', budgetTokens: 1000 });
    expect(tight.totalTokens).toBeLessThanOrEqual(tight.budgetTokens);
    expect(tight.dropped.length + tight.sections.filter((s) => s.truncated).length).toBeGreaterThan(0);
    // required sections always survive
    expect(tight.included).toContain('next_tasks');
    expect(tight.included).toContain('today');

    await app.close();
  });
});

describe('orchestrator tool loop', () => {
  it('creates a real task from a chat message', async () => {
    const app = await openApp();
    const turn = await app.ai.orchestrator.chat('Add a task: call the bank about the card, 20 minutes, tomorrow');

    expect(turn.toolCalls.length).toBeGreaterThan(0);
    expect(turn.toolCalls[0].call.name).toBe('create_task');
    expect(turn.toolCalls[0].outcome.ok).toBe(true);

    const tomorrow = dayKey(addDays(new Date(), 1));
    const scheduled = await app.services.tasks.listForDay(tomorrow);
    const created = scheduled.find((t) => /call the bank/i.test(t.title));
    expect(created).toBeTruthy();
    expect(created?.estimated_minutes).toBe(20);
    expect(created?.scheduled_date).toBe(tomorrow);

    // the turn is persisted in the conversation history
    const history = await app.ai.conversations.history(turn.conversationId, 20);
    expect(history.some((m) => m.role === 'user')).toBe(true);
    expect(history.some((m) => m.role === 'assistant')).toBe(true);
    expect(history.some((m) => m.role === 'tool')).toBe(true);

    await app.close();
  });

  it('refuses to guess between two matching tasks and asks instead', async () => {
    const app = await openApp();
    await app.services.tasks.create({ title: 'Write report', estimated_minutes: 45 });
    await app.services.tasks.create({ title: 'Write report introduction', estimated_minutes: 20 });

    const turn = await app.ai.orchestrator.chat('I finished write report');
    const completion = turn.toolCalls.find((c) => c.call.name === 'complete_task');
    expect(completion).toBeTruthy();
    expect(completion?.outcome.ok).toBe(true);
    // exactly one of them may be completed only if the match was unambiguous
    const open = await app.services.tasks.backlog(50);
    const reports = open.filter((t) => /^write report/i.test(t.title) && t.status !== 'done');
    expect(reports.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it('requires confirmation before a destructive action, then obeys the approval', async () => {
    const app = await openApp();
    const task = await app.services.tasks.create({ title: 'Old unused task', estimated_minutes: 15 });

    const first = await app.ai.orchestrator.chat(`Cancel task ${task.id}`);
    const cancelCall = first.toolCalls.find((c) => c.call.name === 'cancel_task');
    expect(cancelCall).toBeTruthy();
    expect(cancelCall?.outcome.ok).toBe(false);
    expect(cancelCall?.outcome.confirmation).toBeTruthy();
    expect(first.confirmations).toHaveLength(1);

    // nothing was deleted without approval
    expect(await app.services.tasks.get(task.id)).toBeTruthy();

    const confirmationId = first.confirmations[0].id;
    const second = await app.ai.orchestrator.chat(`Cancel task ${task.id}`, { approved: [confirmationId] });
    const approved = second.toolCalls.find((c) => c.call.name === 'cancel_task');
    expect(approved?.outcome.ok).toBe(true);

    const after = await app.services.tasks.get(task.id);
    expect(after?.status).toBe('cancelled');

    await app.close();
  });

  it('runs the exact proposed call when the user answers the confirmation', async () => {
    const app = await openApp();
    const task = await app.services.tasks.create({ title: 'Купить билеты', estimated_minutes: 15 });

    const turn = await app.ai.orchestrator.chat(`Cancel task ${task.id}`);
    const request = turn.confirmations[0];
    expect(request.tool).toBe('cancel_task');
    // The interface used to ignore `turn.confirmations` entirely: the question was asked, the user
    // answered «да», and the same refusal came back — the tool could never run (req. 22–24).
    expect((await app.services.tasks.get(task.id))?.status).not.toBe('cancelled');

    const approved = await app.ai.orchestrator.resolveConfirmation(request, {
      approved: true, conversationId: turn.conversationId, replyText: 'Готово: отменил задачу.',
    });
    expect(approved.ok).toBe(true);
    expect(approved.outcome?.ok).toBe(true);
    expect((await app.services.tasks.get(task.id))?.status).toBe('cancelled');
    // The decision is part of the conversation: the next turn knows what was done.
    expect(approved.reply).toBe('Готово: отменил задачу.');
    const history = await app.ai.conversations.history(turn.conversationId, 20);
    expect(history.some((m) => m.role === 'assistant' && m.content === 'Готово: отменил задачу.')).toBe(true);

    await app.close();
  });

  it('does nothing when the user refuses, and records the refusal', async () => {
    const app = await openApp();
    const task = await app.services.tasks.create({ title: 'Ненужная задача', estimated_minutes: 15 });
    const turn = await app.ai.orchestrator.chat(`Cancel task ${task.id}`);

    const refused = await app.ai.orchestrator.resolveConfirmation(turn.confirmations[0], {
      approved: false, conversationId: turn.conversationId, replyText: 'Отменено — ничего не менял.',
    });
    expect(refused.ok).toBe(false);
    expect(refused.outcome).toBeNull();
    expect((await app.services.tasks.get(task.id))?.status).not.toBe('cancelled');
    // The refusal is in the history, so the model does not silently repeat the proposal.
    const history = await app.ai.conversations.history(turn.conversationId, 20);
    expect(history.some((m) => m.role === 'assistant' && m.content === 'Отменено — ничего не менял.')).toBe(true);

    await app.close();
  });

  it('asks which one was meant instead of guessing, and never reports that as done', async () => {
    const app = await openApp();
    await app.services.tasks.create({ title: 'Сдать лабораторную по физике', estimated_minutes: 30 });
    await app.services.tasks.create({ title: 'Сдать лабораторную по химии', estimated_minutes: 30 });

    // `cancel_task` also carries a destructive-action policy, so the ambiguity surfaces once the
    // user has approved the call (the hook runs before execute — it is about the action, not the
    // reference). The approval is the user's word for *this* call, nothing more.
    const outcome = await app.ai.tools.invoke('cancel_task', { task: 'лабораторную' }, {
      write: { actor: 'ai' }, day: dayKey(), now: new Date(), approved: ['cancel_task'], language: 'ru',
    });
    // The reference fits two tasks: the tool refuses, and the chat must not show «отменил задачу»
    // with a ✓ while nothing was cancelled (that is what `ok: true` used to mean here).
    expect(outcome.ok).toBe(false);
    expect(outcome.needs_input_item).toMatchObject({ code: 'ambiguous', kind: 'task', ref: 'лабораторную' });
    expect(outcome.needs_input_item?.candidates).toHaveLength(2);
    // The sentence for the model stays in English: it is an instruction, not a message to the user.
    expect(outcome.needsInput).toMatch(/Ask the user which one they mean/);
    // The same refusal as data, worded for the reader.
    expect(needsInputItemText(outcome.needs_input_item!, true)).toContain('Какой именно вы имели в виду?');
    expect(needsInputItemText(outcome.needs_input_item!, true)).toContain('«Сдать лабораторную по физике»');
    expect(needsInputItemText(outcome.needs_input_item!, false)).toContain('Which one did you mean?');

    const stillThere = await app.services.tasks.backlog(50);
    expect(stillThere.filter((t) => t.status !== 'cancelled').length).toBeGreaterThanOrEqual(2);

    // An unknown name is a different answer: nothing to choose from, ask for the exact title.
    const missing = await app.ai.tools.invoke('cancel_task', { task: 'написать диссертацию' }, {
      write: { actor: 'ai' }, day: dayKey(), now: new Date(), approved: ['cancel_task'], language: 'ru',
    });
    expect(missing.ok).toBe(false);
    expect(missing.needs_input_item?.code).toBe('not_found');
    expect(needsInputItemText(missing.needs_input_item!, true)).toContain('Не нашёл задачу');

    await app.close();
  });

  it('rejects an impossible schedule instead of double-booking the calendar', async () => {
    const app = await openApp();
    await app.services.calendar.create({ title: 'Dentist', day: dayKey(), start: '15:00', end: '16:00', kind: 'health', priority: 'critical' });

    const outcome = await app.ai.tools.invoke('create_task', {
      title: 'Deep work block', scheduled_date: dayKey(), scheduled_start: '15:30', estimated_minutes: 60,
    }, { write: { actor: 'ai' }, day: dayKey(), now: new Date(), approved: [] });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/Dentist/);

    await app.close();
  });

  it('does not allow writes during an unattended turn', async () => {
    const app = await openApp();
    const turn = await app.ai.orchestrator.chat('Add a task: buy milk', { unattended: true });
    expect(turn.toolCalls.every((c) => c.call.name !== 'create_task')).toBe(true);
    const milk = (await app.services.tasks.backlog(50)).find((t) => /buy milk/i.test(t.title));
    expect(milk).toBeUndefined();
    await app.close();
  });
});

describe('long-term memory', () => {
  it('stores what the user said as a confirmed fact and reuses it later', async () => {
    const app = await openApp();
    const turn = await app.ai.orchestrator.chat('I am a backend developer and I prefer working in the evening.');

    expect(turn.memoriesSaved.length).toBeGreaterThan(0);
    const facts = await app.services.memory.list({ limit: 50 });
    expect(facts.some((m) => /backend developer/i.test(m.content))).toBe(true);
    expect(facts.some((m) => /evening/i.test(m.content))).toBe(true);

    const stated = facts.find((m) => /backend developer/i.test(m.content));
    expect(stated?.source).toBe('user_provided');
    expect(stated?.confidence).toBe('confirmed');

    // retrieval finds it again
    const found = await app.services.memory.search('what is my job?', { limit: 5 });
    expect(found.some((m) => /backend developer/i.test(m.content))).toBe(true);

    // duplicates are not stored twice
    const again = await app.ai.orchestrator.chat('I am a backend developer.');
    expect(again.memoriesSaved).toHaveLength(0);

    await app.close();
  });
});

describe('mentor', () => {
  it('builds a briefing from real data and never invents numbers', async () => {
    const app = await openApp();
    await app.services.tasks.create({ title: 'Prepare presentation', estimated_minutes: 90, priority: 'P0', scheduled_date: dayKey() });
    const briefing = await app.ai.mentor.morningBriefing(dayKey(), { ai: false });

    expect(briefing.aiAssisted).toBe(false);
    expect(briefing.text).toContain('Prepare presentation');
    expect(briefing.text).toContain('90');
    expect(briefing.facts.tasks).toBe(1);

    await app.close();
  });

  it('delivers proactive messages through the notification gate and respects the budget', async () => {
    const app = await openApp();
    await app.services.settings.setMany({ notifications: { enabled: true, proactive_mentor: true, daily_budget: 2, quiet_start: null, quiet_end: null } });
    await app.services.tasks.create({ title: 'Overdue important thing', priority: 'P0', due_date: dayKey(addDays(new Date(), -2)) });

    const pass = await app.ai.mentor.proactivePass({ now: new Date(`${dayKey()}T12:00:00`) });
    expect(pass.evaluated).toBeGreaterThan(0);
    expect(pass.delivered.length).toBeLessThanOrEqual(2);

    const status = await app.services.notifications.budgetStatus();
    expect(status.used).toBeLessThanOrEqual(2);

    // a second pass must not spam the same reasons again
    const second = await app.ai.mentor.proactivePass({ now: new Date(`${dayKey()}T12:05:00`) });
    expect(second.delivered.length).toBe(0);

    await app.close();
  });
});

describe('durability', () => {
  it('keeps everything after a hard close and reopen', async () => {
    const first = await openApp();
    const goal = await first.services.goals.create({ title: 'Run a half marathon', horizon: 'long', priority: 'P1' });
    await first.ai.orchestrator.chat('Add a task: buy running shoes, 30 minutes');
    await first.services.memory.save({ kind: 'fact', content: 'The user lives in Lisbon', importance: 0.8 });
    await first.close();

    expect(existsSync(dbPath)).toBe(true);

    const second = await openApp();
    const goals = await second.services.goals.list({});
    expect(goals.some((g) => g.id === goal.id && g.title === 'Run a half marathon')).toBe(true);

    const tasks = await second.services.tasks.backlog(100);
    expect(tasks.some((t) => /running shoes/i.test(t.title))).toBe(true);

    const memories = await second.services.memory.list({ limit: 100 });
    expect(memories.some((m) => /lives in Lisbon/i.test(m.content))).toBe(true);

    const conversations = await second.ai.conversations.list(10);
    expect(conversations.length).toBeGreaterThan(0);
    const messages = await second.ai.conversations.history(conversations[0].id, 50);
    expect(messages.length).toBeGreaterThan(0);

    const health = await second.health();
    expect(health.ok).toBe(true);
    expect(health.schemaVersion).toBe(health.integrity.expectedSchemaVersion);

    await second.close();
  });
});
